import { v4 as uuid } from "uuid";
import crypto from "crypto";
import { query, queryOne, run, transaction } from "../db/pool.js";
import type { RawEvent } from "../types.js";
import {
  createQuarantineRecord,
  findQuarantineRecordByRawEvent,
  resolveQuarantineRecord,
} from "./quarantine.service.js";

function hashPayload(payload: string): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function ingestEvent(
  fleetId: string,
  connectionId: string,
  sourceVehicleId: string,
  payload: any,
  sourceEventId: string | null
): { status: string; eventId: string; message: string } {
  const payloadStr = JSON.stringify(payload);
  const payloadHash = hashPayload(payloadStr);

  return transaction(() => {
    let rawEventId = uuid();

    if (sourceEventId) {
      const existing = query<{ id: string; payload_hash: string }>(
        `SELECT id, payload_hash FROM raw_events
         WHERE fleet_id = ? AND connection_id = ? AND source_event_id = ?`,
        [fleetId, connectionId, sourceEventId]
      );

      if (existing.length > 0) {
        const exactMatch = existing.find((e) => e.payload_hash === payloadHash);
        if (exactMatch) {
          return { status: "DUPLICATE", eventId: exactMatch.id, message: "Duplicate event received" };
        }
      }
    }

    run(
      `INSERT INTO raw_events (id, fleet_id, connection_id, source_event_id, source_vehicle_id, payload_hash, payload, processing_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [rawEventId, fleetId, connectionId, sourceEventId, sourceVehicleId, payloadHash, payloadStr]
    );

    return processRawEvent(rawEventId);
  });
}

export function processRawEvent(rawEventId: string): { status: string; eventId: string; message: string } {
  const rawEvent = queryOne<RawEvent>(
    "SELECT * FROM raw_events WHERE id = ?",
    [rawEventId]
  );
  if (!rawEvent) throw new Error("Raw event not found");

  const connectionRow = queryOne<{ oem_id: string; fleet_id: string; status: string }>(
    "SELECT oem_id, fleet_id, status FROM oem_connections WHERE id = ?",
    [rawEvent.connection_id]
  );

  if (!connectionRow) {
    quarantineEvent(rawEventId, rawEvent, null, "Unknown connection", "INFRA_ERROR");
    return { status: "QUARANTINED", eventId: rawEventId, message: "Unknown connection" };
  }

  if (connectionRow.status === "EXPIRED") {
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, "OEM account authorisation has expired", "EXPIRED_AUTH");
    return { status: "QUARANTINED", eventId: rawEventId, message: "Expired authorisation" };
  }

  let payloadObj: any;
  try {
    payloadObj = JSON.parse(rawEvent.payload);
  } catch {
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, "Invalid JSON payload", "INFRA_ERROR");
    return { status: "QUARANTINED", eventId: rawEventId, message: "Invalid JSON" };
  }

  const detectedVersion = detectFormatVersion(connectionRow.oem_id, payloadObj);
  if (!detectedVersion) {
    const observed = JSON.stringify(Object.keys(payloadObj)).slice(0, 80);
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id,
      `Unknown OEM format – observed keys: ${observed}`,
      "SCHEMA_CHANGE",
      undefined,
      observed
    );
    return { status: "QUARANTINED", eventId: rawEventId, message: "Unknown format version" };
  }

  if (connectionRow.oem_id === "oem_navarro") {
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id,
      "Unsupported OEM for data ingestion", "UNSUPPORTED_OEM");
    return { status: "QUARANTINED", eventId: rawEventId, message: "Unsupported OEM" };
  }

  const oemFormat = queryOne<{ id: string; expected_structure: string }>(
    "SELECT id, expected_structure FROM oem_format_versions WHERE oem_id = ? AND format_version = ?",
    [connectionRow.oem_id, detectedVersion]
  );

  if (!oemFormat) {
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id,
      `Unknown OEM format version: ${detectedVersion}`, "UNKNOWN_FORMAT");
    return { status: "QUARANTINED", eventId: rawEventId, message: "Unknown format version" };
  }

  const profile = queryOne<{ id: string }>(
    "SELECT id FROM mapping_profiles WHERE oem_format_version_id = ? AND status = 'ACTIVE'",
    [oemFormat.id]
  );

  if (!profile) {
    const expectedStructure = oemFormat.expected_structure || "unknown";
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id,
      `No active mapping profile for format ${detectedVersion}`,
      "SCHEMA_CHANGE",
      expectedStructure,
      detectedVersion
    );
    return { status: "QUARANTINED", eventId: rawEventId, message: "No active mapping" };
  }

  const mappingRow = queryOne<{ id: string }>(
    "SELECT id FROM vehicle_source_mappings WHERE connection_id = ? AND oem_vehicle_id = ?",
    [rawEvent.connection_id, rawEvent.source_vehicle_id]
  );

  if (!mappingRow) {
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id,
      "Vehicle not mapped to any fleet vehicle", "MISSING_VEHICLE_MAPPING");
    return { status: "QUARANTINED", eventId: rawEventId, message: "Vehicle not mapped" };
  }

  const vehicleRow = queryOne<{ vehicle_id: string }>(
    "SELECT vehicle_id FROM vehicle_source_mappings WHERE id = ?",
    [mappingRow.id]
  );
  if (!vehicleRow) {
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id,
      "Vehicle ID not found in mappings", "MISSING_VEHICLE_MAPPING");
    return { status: "QUARANTINED", eventId: rawEventId, message: "Vehicle ID not found" };
  }

  const vehicleId = vehicleRow.vehicle_id;
  const rules = query<any>(
    "SELECT mr.*, cs.name as signal_name, cs.data_type, cs.valid_range_min, cs.valid_range_max FROM mapping_rules mr JOIN canonical_signals cs ON mr.destination_signal_id = cs.id WHERE mr.mapping_profile_id = ?",
    [profile.id]
  );

  const normalized: Record<string, any> = {};
  const qualityFlags: string[] = [];
  let hasError = false;
  let errorReason = "";

  for (const rule of rules) {
    const rawValue = getNestedValue(payloadObj, rule.source_field_path);
    if (rawValue === undefined || rawValue === null) continue;

    let value = rawValue;

    if (rule.conversion_type === "MPH_TO_KMH") {
      value = Number(value) * 1.60934;
    } else if (rule.conversion_type === "FRACTION_TO_PERCENT") {
      value = Number(value) * 100;
    } else if (rule.conversion_type === "MILES_TO_KM") {
      value = Number(value) * 1.60934;
    } else if (rule.conversion_type === "ENUM_MAP" && rule.enum_mapping) {
      const map = JSON.parse(rule.enum_mapping);
      value = map[String(value)] ?? value;
    }

    if (rule.data_type === "NUMBER") {
      value = Number(value);
      if (isNaN(value)) {
        hasError = true;
        errorReason = `Invalid number value for signal ${rule.signal_name} (type error)`;
        break;
      }
      if (rule.valid_range_min !== null && value < rule.valid_range_min) {
        hasError = true;
        errorReason = `Value ${value} below minimum ${rule.valid_range_min} for ${rule.signal_name} (invalid value)`;
        break;
      }
      if (rule.valid_range_max !== null && value > rule.valid_range_max) {
        hasError = true;
        errorReason = `Value ${value} above maximum ${rule.valid_range_max} for ${rule.signal_name} (invalid value)`;
        break;
      }
    }

    normalized[rule.signal_name] = value;
  }

  if (hasError) {
    run(
      `INSERT INTO normalization_attempts (id, raw_event_id, mapping_profile_id, status, failure_reason)
       VALUES (?, ?, ?, 'FAILED', ?)`,
      [uuid(), rawEventId, profile.id, errorReason]
    );
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, errorReason, "INVALID_VALUE", undefined, undefined, vehicleId);
    return { status: "QUARANTINED", eventId: rawEventId, message: errorReason };
  }

  const eventTime = normalized["event_time"] || null;
  const latitude = typeof normalized["latitude"] === "number" ? normalized["latitude"] : null;
  const longitude = typeof normalized["longitude"] === "number" ? normalized["longitude"] : null;
  const altitude = typeof normalized["altitude"] === "number" ? normalized["altitude"] : null;

  const normalizedEventId = uuid();
  run(
    `INSERT INTO normalization_attempts (id, raw_event_id, mapping_profile_id, status)
     VALUES (?, ?, ?, 'SUCCESS')`,
    [uuid(), rawEventId, profile.id]
  );

  run(
    `INSERT INTO normalized_events
       (id, raw_event_id, vehicle_id, mapping_profile_id, canonical_values, quality_flags,
        event_time, latitude, longitude, altitude)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [normalizedEventId, rawEventId, vehicleId, profile.id,
     JSON.stringify(normalized), JSON.stringify(qualityFlags),
     eventTime, latitude, longitude, altitude]
  );

  run(
    `UPDATE raw_events SET processing_status = 'PROCESSED' WHERE id = ?`,
    [rawEventId]
  );

  const signalTimestamps: Record<string, string> = {};
  const ts = eventTime || new Date().toISOString();
  for (const key of Object.keys(normalized)) {
    signalTimestamps[key] = ts;
  }

  run(
    `INSERT INTO vehicle_current_state (vehicle_id, latest_values, signal_timestamps, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(vehicle_id) DO UPDATE SET
       latest_values = excluded.latest_values,
       signal_timestamps = excluded.signal_timestamps,
       updated_at = excluded.updated_at`,
    [vehicleId, JSON.stringify(normalized), JSON.stringify(signalTimestamps)]
  );

  run(
    "UPDATE vehicles SET last_data_at = datetime('now'), data_status = 'RECEIVING' WHERE id = ?",
    [vehicleId]
  );
  run(
    "UPDATE oem_connections SET last_data_received = datetime('now') WHERE id = ?",
    [rawEvent.connection_id]
  );

  enqueueJob("BUILD_PROJECTIONS", { vehicleId, eventTime });

  return { status: "PROCESSED", eventId: rawEventId, message: "Successfully processed" };
}

function detectFormatVersion(oemId: string, payload: any): string | null {
  if (oemId === "oem_voltera") {
    if (payload.data && payload.metadata) return "v2";
    if (payload.speed_mph !== undefined || payload.charge_fraction !== undefined || payload.odo_miles !== undefined) return "v1";
    return null;
  }
  if (oemId === "oem_crestline") {
    if (payload.state && (payload.state.velocity_kmh !== undefined || payload.state.distance_km !== undefined)) return "v1";
    if (payload.velocity_kmh !== undefined) return "v1";
    return null;
  }
  return null;
}

function quarantineEvent(
  rawEventId: string,
  rawEvent: RawEvent,
  oemId: string | null,
  reason: string,
  category: string,
  expectedFormat?: string,
  observedFormat?: string,
  vehicleId?: string
): void {
  run(
    `UPDATE raw_events SET processing_status = 'QUARANTINED' WHERE id = ?`,
    [rawEventId]
  );

  run(
    `INSERT INTO normalization_attempts (id, raw_event_id, status, failure_reason)
     VALUES (?, ?, 'FAILED', ?)`,
    [uuid(), rawEventId, reason]
  );

  if (!oemId) return;

  createQuarantineRecord({
    rawEventId,
    fleetId: rawEvent.fleet_id,
    connectionId: rawEvent.connection_id,
    oemId,
    vehicleId: vehicleId || null,
    failureReason: reason,
    expectedFormat,
    observedFormat,
  });
}

function enqueueJob(jobType: string, payload: any): void {
  run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority)
     VALUES (?, ?, ?, 'PENDING', 5)`,
    [uuid(), jobType, JSON.stringify(payload)]
  );
}

function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((acc, part) => acc && acc[part], obj);
}

export function replayEvents(mappingProfileId: string, selectionCriteria?: any): { jobId: string } {
  const jobId = uuid();
  run(
    `INSERT INTO replay_jobs (id, mapping_profile_id, selection_criteria, status) VALUES (?, ?, ?, 'PENDING')`,
    [jobId, mappingProfileId, JSON.stringify(selectionCriteria || {})]
  );

  setTimeout(() => runReplayJob(jobId, mappingProfileId), 0);
  return { jobId };
}

export function runReplayJob(jobId: string, mappingProfileId: string): void {
  const profile = queryOne<{ oem_format_version_id: string }>(
    "SELECT oem_format_version_id FROM mapping_profiles WHERE id = ?",
    [mappingProfileId]
  );
  if (!profile) return;

  const oemFormat = queryOne<{ oem_id: string; format_version: string }>(
    "SELECT oem_id, format_version FROM oem_format_versions WHERE id = ?",
    [profile.oem_format_version_id]
  );
  if (!oemFormat) return;

  const jobRow = queryOne<{ selection_criteria: string }>(
    "SELECT selection_criteria FROM replay_jobs WHERE id = ?",
    [jobId]
  );
  const criteria = jobRow ? JSON.parse(jobRow.selection_criteria || "{}") : {};

  run("UPDATE replay_jobs SET status = 'RUNNING' WHERE id = ?", [jobId]);

  let rawEventsSql = `
    SELECT re.* FROM raw_events re
    WHERE re.processing_status = 'QUARANTINED'
  `;
  const params: unknown[] = [];
  if (criteria.connection_id) {
    rawEventsSql += " AND re.connection_id = ?";
    params.push(criteria.connection_id);
  }
  if (criteria.fleet_id) {
    rawEventsSql += " AND re.fleet_id = ?";
    params.push(criteria.fleet_id);
  }

  const rawEvents = query<RawEvent>(rawEventsSql, params);
  let processed = 0;
  let error = 0;

  for (const evt of rawEvents) {
    try {
      const quarantineRecord = findQuarantineRecordByRawEvent(evt.id);
      const res = processRawEvent(evt.id);
      if (res.status === "PROCESSED") {
        processed++;
        if (quarantineRecord) {
          resolveQuarantineRecord(quarantineRecord.id);
        }
      } else {
        error++;
        if (quarantineRecord) {
          run(
            `UPDATE quarantine_records SET status = 'REPLAY_FAILED', latest_attempt_at = datetime('now') WHERE id = ?`,
            [quarantineRecord.id]
          );
        }
      }
    } catch (e: any) {
      error++;
    }
  }

  run(
    `UPDATE replay_jobs SET status = 'COMPLETED', total_events = ?, processed_events = ?, error_events = ?, completed_at = datetime('now') WHERE id = ?`,
    [rawEvents.length, processed, error, jobId]
  );
}
