import { v4 as uuid } from "uuid";
import crypto from "crypto";
import { query, queryOne, run, transaction } from "../db/pool.js";
import type { RawEvent } from "../types.js";
import {
  createQuarantineRecord,
  findQuarantineRecordByRawEvent,
  resolveQuarantineRecord,
  markQuarantineRecordReplayFailed,
} from "./quarantine.service.js";
import {
  detectAndValidateFormat,
  getNestedValue,
} from "./format-contract.service.js";
import { buildProjectionsForVehicle } from "./projection.service.js";
import { recordFleetEventDurable, publishFleetEventSocket, recordAndPublishFleetEvent, type FleetSocketMessage } from "./fleet-event.service.js";
import {
  computeVehicleLiveState,
  computeMovementState,
  computeDataFreshness,
} from "./vehicle-state.service.js";
import { recalculateFleetInsights } from "./insight.service.js";
import { findLiveRepair, repairSignals } from "./mapping-repair.service.js";
import { evaluateRepair } from "./mapping-repair.engine.js";

function safeJson(val: any, fallback: any): any {
  if (!val) return fallback;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

function hashPayload(payload: string): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function computeIdempotencyKey(connectionId: string, payloadHash: string, sourceEventId?: string | null): string {
  if (sourceEventId && sourceEventId.trim().length > 0) {
    return `${connectionId}:${sourceEventId}`;
  }
  return `${connectionId}:hash:${payloadHash}`;
}

export function ingestEvent(
  fleetId: string,
  connectionId: string,
  sourceVehicleId: string,
  payload: any,
  sourceEventId?: string | null,
  asyncMode: boolean = false
): { status: string; eventId: string; message: string } {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  const payloadHash = hashPayload(payloadStr);
  const idempotencyKey = computeIdempotencyKey(connectionId, payloadHash, sourceEventId);

  return transaction(() => {
    const conn = queryOne<{ oem_id: string; fleet_id: string }>(
      "SELECT oem_id, fleet_id FROM oem_connections WHERE id = ?",
      [connectionId]
    );
    if (!conn || conn.fleet_id !== fleetId) {
      throw new Error("Connection not found");
    }

    if (sourceEventId) {
      const existing = query<{ id: string; payload_hash: string }>(
        `SELECT id, payload_hash FROM raw_events
         WHERE connection_id = ? AND source_event_id = ?`,
        [connectionId, sourceEventId]
      );

      if (existing.length > 0) {
        const exactMatch = existing.find((e) => e.payload_hash === payloadHash);
        if (exactMatch) {
          return { status: "DUPLICATE", eventId: exactMatch.id, message: "Duplicate event received" };
        }

        const rawEventId = uuid();
        const reason = `Reused source event ID '${sourceEventId}' with conflicting payload`;
        const mappingRow = queryOne<{ vehicle_id: string }>(
          "SELECT vehicle_id FROM vehicle_source_mappings WHERE connection_id = ? AND oem_vehicle_id = ?",
          [connectionId, sourceVehicleId]
        );
        const vehicleId = mappingRow ? mappingRow.vehicle_id : null;

        run(
          `INSERT INTO raw_events
             (id, fleet_id, connection_id, source_event_id, source_vehicle_id, payload_hash, payload, processing_status, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'QUARANTINED', ?)`,
          [rawEventId, fleetId, connectionId, sourceEventId, sourceVehicleId, payloadHash, payloadStr, idempotencyKey]
        );

        quarantineEvent(
          rawEventId,
          {
            id: rawEventId,
            fleet_id: fleetId,
            connection_id: connectionId,
            source_event_id: sourceEventId,
            source_vehicle_id: sourceVehicleId,
            payload_hash: payloadHash,
            payload: payloadStr,
            processing_status: "QUARANTINED",
            recorded_at: new Date(),
          },
          conn.oem_id,
          reason,
          "IDEMPOTENCY_CONFLICT",
          undefined,
          undefined,
          vehicleId
        );

        return { status: "QUARANTINED", eventId: rawEventId, message: reason };
      }
    }

    const payloadMatch = queryOne<{ id: string }>(
      `SELECT id FROM raw_events
       WHERE connection_id = ? AND payload_hash = ?`,
      [connectionId, payloadHash]
    );

    if (payloadMatch) {
      return { status: "DUPLICATE", eventId: payloadMatch.id, message: "Duplicate payload received" };
    }

    const rawEventId = uuid();
    run(
      `INSERT INTO raw_events
         (id, fleet_id, connection_id, source_event_id, source_vehicle_id, payload_hash, payload, processing_status, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [rawEventId, fleetId, connectionId, sourceEventId || null, sourceVehicleId, payloadHash, payloadStr, idempotencyKey]
    );

    if (asyncMode) {
      run(
        `INSERT INTO job_queue (id, job_type, payload, status, priority, attempts, max_attempts)
         VALUES (?, 'NORMALIZE_RAW_EVENT', ?, 'PENDING', 5, 0, 3)`,
        [uuid(), JSON.stringify({ rawEventId })]
      );
      return { status: "ACCEPTED", eventId: rawEventId, message: "Event accepted for processing" };
    }

    return processRawEvent(rawEventId);
  });
}

export function processRawEvent(
  rawEventId: string,
  forcedMappingProfileId?: string,
  replayJobId?: string
): { status: string; eventId: string; message: string } {
  const rawEvent = queryOne<RawEvent>(
    "SELECT * FROM raw_events WHERE id = ?",
    [rawEventId]
  );

  if (!rawEvent) {
    return { status: "ERROR", eventId: rawEventId, message: "Raw event not found" };
  }

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
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, "Invalid JSON payload", "SCHEMA_CHANGE");
    return { status: "QUARANTINED", eventId: rawEventId, message: "Invalid JSON" };
  }

  const formatResult = detectAndValidateFormat(connectionRow.oem_id, payloadObj);

  const forcedRepair = forcedMappingProfileId ? queryOne<any>("SELECT mr.*, mp.status FROM mapping_repairs mr JOIN mapping_profiles mp ON mp.id = mr.profile_id WHERE mr.profile_id = ?", [forcedMappingProfileId]) : undefined;
  const repair = forcedRepair ? { ...forcedRepair, configuration: JSON.parse(forcedRepair.configuration) }
    : !forcedMappingProfileId ? findLiveRepair(rawEvent.fleet_id, rawEvent.connection_id, payloadObj, formatResult.valid) : undefined;
  let repairValues: Record<string, any> | undefined;
  let repairWarnings: string[] = [];
  let profile: { id: string; canonical_schema_version: string } | undefined;
  if (repair) {
    if (repair.fleet_id !== rawEvent.fleet_id || repair.connection_id !== rawEvent.connection_id || repair.status !== "ACTIVE") {
      return { status: "QUARANTINED", eventId: rawEventId, message: "Mapping repair is not published for this connection" };
    }
    if (queryOne("SELECT id FROM quarantine_records WHERE raw_event_id = ? AND failure_category = 'IDEMPOTENCY_CONFLICT'", [rawEventId])) {
      return { status: "QUARANTINED", eventId: rawEventId, message: "Conflicting source event identity requires OEM investigation" };
    }
    const result = evaluateRepair(repair.configuration, payloadObj, repairSignals());
    if (!result.success) {
      const reason = result.errors.join("; ");
      quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, reason, "INVALID_VALUE", undefined, undefined, undefined, repair.profile_id, replayJobId);
      return { status: "QUARANTINED", eventId: rawEventId, message: reason };
    }
    repairValues = result.normalized;
    repairWarnings = result.warnings.map(warning => `MISSING_OPTIONAL: ${warning}`);
    profile = { id: repair.profile_id, canonical_schema_version: "1.0" };
  } else {

  if (!formatResult.valid) {
    const category = formatResult.failureCategory || "SCHEMA_CHANGE";
    const reason = formatResult.errorReason || "Format contract validation failed";
    quarantineEvent(
      rawEventId,
      rawEvent,
      connectionRow.oem_id,
      reason,
      category,
      undefined,
      formatResult.observedStructure
    );
    return { status: "QUARANTINED", eventId: rawEventId, message: reason };
  }

  const detectedVersion = formatResult.detectedVersion!;

  if (forcedMappingProfileId) {
    const forcedProfile = queryOne<{ id: string; oem_format_version_id: string; canonical_schema_version: string; status: string }>(
      "SELECT id, oem_format_version_id, canonical_schema_version, status FROM mapping_profiles WHERE id = ?",
      [forcedMappingProfileId]
    );
    if (!forcedProfile) {
      quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, `Forced mapping profile not found: ${forcedMappingProfileId}`, "UNKNOWN_FORMAT");
      return { status: "QUARANTINED", eventId: rawEventId, message: "Mapping profile not found" };
    }
    const oemFormat = queryOne<{ id: string; oem_id: string; format_version: string }>(
      "SELECT id, oem_id, format_version FROM oem_format_versions WHERE id = ?",
      [forcedProfile.oem_format_version_id]
    );
    if (!oemFormat || oemFormat.oem_id !== connectionRow.oem_id || oemFormat.format_version !== detectedVersion) {
      quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, `Mapping profile ${forcedMappingProfileId} does not match format ${detectedVersion}`, "SCHEMA_CHANGE");
      return { status: "QUARANTINED", eventId: rawEventId, message: "Mapping profile mismatch" };
    }
    profile = forcedProfile;
  } else {
    const oemFormat = queryOne<{ id: string; expected_structure: string }>(
      "SELECT id, expected_structure FROM oem_format_versions WHERE oem_id = ? AND format_version = ?",
      [connectionRow.oem_id, detectedVersion]
    );

    if (!oemFormat) {
      quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id,
        `Unknown OEM format version: ${detectedVersion}`, "UNKNOWN_FORMAT");
      return { status: "QUARANTINED", eventId: rawEventId, message: "Unknown format version" };
    }

    profile = queryOne<{ id: string; canonical_schema_version: string }>(
      "SELECT id, canonical_schema_version FROM mapping_profiles WHERE oem_format_version_id = ? AND status = 'ACTIVE'",
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
  }

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

  const vehicleId = vehicleRow ? vehicleRow.vehicle_id : null;

  const rules = repairValues ? [] : query<any>(
    "SELECT mr.*, cs.name as signal_name, cs.data_type, cs.valid_range_min, cs.valid_range_max FROM mapping_rules mr JOIN canonical_signals cs ON mr.destination_signal_id = cs.id WHERE mr.mapping_profile_id = ?",
    [profile.id]
  );

  const normalized: Record<string, any> = repairValues || {};
  const qualityFlags: string[] = repairWarnings;
  let hasError = false;
  let errorReason = "";
  let errorCategory = "INVALID_VALUE";

  for (const rule of rules) {
    let rawValue = getNestedValue(payloadObj, rule.source_field_path);

    if ((rawValue === undefined || rawValue === null) && connectionRow.oem_id === "oem_crestline" && rule.source_field_path.startsWith("state.")) {
      rawValue = getNestedValue(payloadObj, rule.source_field_path.replace("state.", ""));
    }

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
        errorCategory = "TYPE_ERROR";
        errorReason = `Invalid number value for signal ${rule.signal_name} (type error)`;
        break;
      }
      if (rule.valid_range_min !== null && value < rule.valid_range_min) {
        hasError = true;
        errorCategory = rule.signal_name.includes("latitude") || rule.signal_name.includes("longitude") ? "INVALID_COORDINATES" : "INVALID_VALUE";
        errorReason = `Value ${value} below minimum ${rule.valid_range_min} for ${rule.signal_name} (invalid value)`;
        break;
      }
      if (rule.valid_range_max !== null && value > rule.valid_range_max) {
        hasError = true;
        errorCategory = rule.signal_name.includes("latitude") || rule.signal_name.includes("longitude") ? "INVALID_COORDINATES" : "INVALID_VALUE";
        errorReason = `Value ${value} above maximum ${rule.valid_range_max} for ${rule.signal_name} (invalid value)`;
        break;
      }
    }

    normalized[rule.signal_name] = value;
  }

  if (hasError) {
    run(
      `INSERT INTO normalization_attempts (id, raw_event_id, mapping_profile_id, replay_job_id, status, failure_reason)
       VALUES (?, ?, ?, ?, 'FAILED', ?)`,
      [uuid(), rawEventId, profile.id, replayJobId || null, errorReason]
    );
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, errorReason, errorCategory, undefined, undefined, vehicleId, profile.id, replayJobId, true);
    return { status: "QUARANTINED", eventId: rawEventId, message: errorReason };
  }

  const eventTime = normalized["event_time"] || null;
  const latitude = typeof normalized["latitude"] === "number" ? normalized["latitude"] : null;
  const longitude = typeof normalized["longitude"] === "number" ? normalized["longitude"] : null;
  const altitude = typeof normalized["altitude"] === "number" ? normalized["altitude"] : null;

  if (latitude !== null && (latitude < -90 || latitude > 90)) {
    const msg = `Latitude ${latitude} is outside valid GPS bounds [-90, 90]`;
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, msg, "INVALID_COORDINATES", undefined, undefined, vehicleId, profile.id, replayJobId);
    return { status: "QUARANTINED", eventId: rawEventId, message: msg };
  }

  if (longitude !== null && (longitude < -180 || longitude > 180)) {
    const msg = `Longitude ${longitude} is outside valid GPS bounds [-180, 180]`;
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, msg, "INVALID_COORDINATES", undefined, undefined, vehicleId, profile.id, replayJobId);
    return { status: "QUARANTINED", eventId: rawEventId, message: msg };
  }

  if (eventTime !== null && isNaN(new Date(eventTime).getTime())) {
    const msg = `Invalid event time format '${eventTime}'`;
    quarantineEvent(rawEventId, rawEvent, connectionRow.oem_id, msg, "INVALID_TIME", undefined, undefined, vehicleId, profile.id, replayJobId);
    return { status: "QUARANTINED", eventId: rawEventId, message: msg };
  }

  const pendingNotifications: FleetSocketMessage[] = [];

  transaction(() => {
    const normalizedEventId = uuid();
    run(
      `INSERT INTO normalization_attempts (id, raw_event_id, mapping_profile_id, replay_job_id, status)
       VALUES (?, ?, ?, ?, 'SUCCESS')`,
      [uuid(), rawEventId, profile.id, replayJobId || null]
    );

    run(
      `INSERT INTO normalized_events
         (id, raw_event_id, vehicle_id, mapping_profile_id, canonical_schema_version, canonical_values, quality_flags,
          event_time, latitude, longitude, altitude)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(raw_event_id) DO UPDATE SET
         mapping_profile_id = excluded.mapping_profile_id,
         canonical_schema_version = excluded.canonical_schema_version,
         canonical_values = excluded.canonical_values,
         quality_flags = excluded.quality_flags,
         event_time = excluded.event_time,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         altitude = excluded.altitude`,
      [
        normalizedEventId,
        rawEventId,
        vehicleId,
        profile.id,
        profile.canonical_schema_version || "1.0",
        JSON.stringify(normalized),
        JSON.stringify(qualityFlags),
        eventTime,
        latitude,
        longitude,
        altitude,
      ]
    );

    run(
      `UPDATE raw_events SET processing_status = 'PROCESSED' WHERE id = ?`,
      [rawEventId]
    );

    const currentStateRow = queryOne<any>(
      "SELECT latest_values, signal_timestamps FROM vehicle_current_state WHERE vehicle_id = ?",
      [vehicleId]
    );

    let isOutOfOrder = false;
    const existingValues: Record<string, any> = currentStateRow?.latest_values ? safeJson(currentStateRow.latest_values, {}) : {};
    const existingTimestamps: Record<string, string> = currentStateRow?.signal_timestamps ? safeJson(currentStateRow.signal_timestamps, {}) : {};
    const mergedValues: Record<string, any> = { ...existingValues };
    const signalTimestamps: Record<string, string> = { ...existingTimestamps };

    const incomingTs = eventTime || new Date().toISOString();
    const incomingTimeMs = eventTime ? new Date(eventTime).getTime() : Date.now();

    for (const [key, val] of Object.entries(normalized)) {
      if (val === undefined || val === null) continue;
      const existingSignalTime = existingTimestamps[key];
      if (existingSignalTime && eventTime) {
        const existingTimeMs = new Date(existingSignalTime).getTime();
        if (incomingTimeMs < existingTimeMs) {
          isOutOfOrder = true;
          continue;
        }
      }
      mergedValues[key] = val;
      signalTimestamps[key] = incomingTs;
    }

    run(
      `INSERT INTO vehicle_current_state (vehicle_id, latest_values, signal_timestamps, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(vehicle_id) DO UPDATE SET
         latest_values = excluded.latest_values,
         signal_timestamps = excluded.signal_timestamps,
         updated_at = excluded.updated_at`,
      [vehicleId, JSON.stringify(mergedValues), JSON.stringify(signalTimestamps)]
    );

    const currentSpeed = mergedValues.vehicle_speed !== undefined && mergedValues.vehicle_speed !== null
      ? Number(mergedValues.vehicle_speed)
      : null;
    const currentLat = typeof mergedValues.latitude === "number" ? mergedValues.latitude : null;
    const currentLon = typeof mergedValues.longitude === "number" ? mergedValues.longitude : null;
    const currentAlt = typeof mergedValues.altitude === "number" ? mergedValues.altitude : null;
    const currentIgnition = mergedValues.ignition_status ?? null;
    const currentSoc = mergedValues.battery_soc !== undefined && mergedValues.battery_soc !== null
      ? Number(mergedValues.battery_soc)
      : null;
    const currentOdometer = mergedValues.odometer !== undefined && mergedValues.odometer !== null
      ? Number(mergedValues.odometer)
      : null;

    const liveState = computeVehicleLiveState({
      hasActiveConnection: true,
      lastReceiptTime: new Date(),
      sourceEventTime: eventTime,
      speed: currentSpeed,
      ignition: currentIgnition,
      charging: mergedValues.charging_state === "CHARGING" || mergedValues.charging === true,
    });

    const movementState = computeMovementState(
      currentSpeed,
      currentIgnition,
      mergedValues.charging_state === "CHARGING" || mergedValues.charging === true
    );

    const dataFreshness = computeDataFreshness({
      hasActiveConnection: true,
      lastReceiptTime: new Date(),
    });

    run(
      "UPDATE vehicles SET last_data_at = datetime('now'), data_status = 'RECEIVING', live_state = ?, last_telemetry_time = ? WHERE id = ?",
      [liveState, eventTime || new Date().toISOString(), vehicleId]
    );
    run(
      "UPDATE oem_connections SET last_data_received = datetime('now') WHERE id = ?",
      [rawEvent.connection_id]
    );

    const vehRow = queryOne<any>("SELECT vin, label FROM vehicles WHERE id = ?", [vehicleId]);

    const telemetryMsg = recordFleetEventDurable({
      fleetId: rawEvent.fleet_id,
      eventType: "vehicle:telemetry",
      eventId: rawEventId,
      vehicleId: vehicleId || undefined,
      sourceEventTime: eventTime || undefined,
      serverReceivedTime: new Date().toISOString(),
      payload: {
        vehicle_id: vehicleId,
        vin: vehRow?.vin,
        label: vehRow?.label,
        latitude: currentLat,
        longitude: currentLon,
        altitude: currentAlt,
        speed: currentSpeed,
        speed_unit: "km/h",
        ignition: currentIgnition,
        battery_soc: currentSoc,
        odometer: currentOdometer,
        state: liveState,
        movement_state: movementState,
        data_freshness: dataFreshness,
        is_out_of_order: isOutOfOrder,
        latest_values: mergedValues,
        signal_timestamps: signalTimestamps,
        normalized,
      },
    });
    pendingNotifications.push(telemetryMsg);

    const connHealth = queryOne<{ oem_id: string; status: string; last_data_received?: string }>(
      "SELECT oem_id, status, last_data_received FROM oem_connections WHERE id = ?",
      [rawEvent.connection_id]
    );
    if (connHealth) {
      const connMsg = recordFleetEventDurable({
        fleetId: rawEvent.fleet_id,
        eventType: "connection:health",
        eventId: rawEventId,
        sourceEventTime: eventTime || undefined,
        serverReceivedTime: new Date().toISOString(),
        payload: {
          connectionId: rawEvent.connection_id,
          oemId: connHealth.oem_id,
          status: connHealth.status,
          lastDataReceived: connHealth.last_data_received,
        },
      });
      pendingNotifications.push(connMsg);
    }

    if (!replayJobId) {
      enqueueJob("BUILD_PROJECTIONS", { vehicleId, eventTime });
    }
  });

  for (const notification of pendingNotifications) {
    publishFleetEventSocket(notification);
  }

  return { status: "PROCESSED", eventId: rawEventId, message: "Successfully processed" };
}

function quarantineEvent(
  rawEventId: string,
  rawEvent: RawEvent,
  oemId: string | null,
  reason: string,
  category: string,
  expectedFormat?: string,
  observedFormat?: string,
  vehicleId?: string | null,
  mappingProfileId?: string | null,
  replayJobId?: string | null,
  skipAttemptInsert?: boolean
): void {
  run(
    `UPDATE raw_events SET processing_status = 'QUARANTINED' WHERE id = ?`,
    [rawEventId]
  );

  if (!skipAttemptInsert) {
    run(
      `INSERT INTO normalization_attempts (id, raw_event_id, mapping_profile_id, replay_job_id, status, failure_reason)
       VALUES (?, ?, ?, ?, 'FAILED', ?)`,
      [uuid(), rawEventId, mappingProfileId || null, replayJobId || null, reason]
    );
  }

  if (!oemId) return;

  const existingRecord = findQuarantineRecordByRawEvent(rawEventId);
  const affectedVehicleId = vehicleId || queryOne<{ vehicle_id: string }>("SELECT vsm.vehicle_id FROM vehicle_source_mappings vsm JOIN vehicles v ON v.id = vsm.vehicle_id WHERE vsm.connection_id = ? AND vsm.oem_vehicle_id = ? AND v.fleet_id = ?", [rawEvent.connection_id, rawEvent.source_vehicle_id, rawEvent.fleet_id])?.vehicle_id;
  if (existingRecord && existingRecord.status !== "RESOLVED") {
    run("UPDATE quarantine_records SET failure_detail = ?, vehicle_id = COALESCE(vehicle_id, ?), latest_attempt_at = datetime('now') WHERE id = ?", [reason, affectedVehicleId || null, existingRecord.id]);
  } else createQuarantineRecord({
    rawEventId,
    fleetId: rawEvent.fleet_id,
    connectionId: rawEvent.connection_id,
    oemId,
    vehicleId: affectedVehicleId || null,
    failureReason: reason,
    category: category as any,
    expectedFormat,
    observedFormat,
  });

  const qSummary = queryOne<any>(
    "SELECT COUNT(DISTINCT raw_event_id) as count FROM quarantine_records WHERE fleet_id = ? AND status != 'RESOLVED'",
    [rawEvent.fleet_id]
  );
  const qVehicles = queryOne<any>(
    "SELECT COUNT(DISTINCT vehicle_id) as count FROM quarantine_records WHERE fleet_id = ? AND status != 'RESOLVED'",
    [rawEvent.fleet_id]
  );

  recordAndPublishFleetEvent({
    fleetId: rawEvent.fleet_id,
    eventType: "quarantine:count",
    eventId: rawEventId,
    vehicleId: vehicleId || undefined,
    sourceEventTime: rawEvent.recorded_at,
    serverReceivedTime: new Date().toISOString(),
    payload: {
      unresolvedCount: qSummary?.count || 0,
      affectedVehicleCount: qVehicles?.count || 0,
      reason,
      category,
    },
  });
}

function enqueueJob(jobType: string, payload: any): void {
  if (jobType === "BUILD_PROJECTIONS" && payload?.vehicleId) {
    const existing = queryOne<any>(
      `SELECT id, payload FROM job_queue
       WHERE job_type = 'BUILD_PROJECTIONS' AND status = 'PENDING'
         AND json_extract(payload, '$.vehicleId') = ?`,
      [payload.vehicleId]
    );
    if (existing) {
      let existingPayload: any = {};
      try {
        existingPayload = JSON.parse(existing.payload);
      } catch {}

      const from1 = existingPayload.eventTime ? new Date(existingPayload.eventTime).getTime() : Infinity;
      const from2 = payload.eventTime ? new Date(payload.eventTime).getTime() : Infinity;
      const minFrom = Math.min(from1, from2);

      const to1 = existingPayload.toTime
        ? new Date(existingPayload.toTime).getTime()
        : (existingPayload.eventTime ? new Date(existingPayload.eventTime).getTime() : 0);
      const to2 = payload.eventTime ? new Date(payload.eventTime).getTime() : 0;
      const maxTo = Math.max(to1, to2);

      const merged = {
        vehicleId: payload.vehicleId,
        eventTime: minFrom !== Infinity ? new Date(minFrom).toISOString() : undefined,
        toTime: maxTo !== 0 ? new Date(maxTo).toISOString() : undefined,
      };

      run("UPDATE job_queue SET payload = ? WHERE id = ?", [JSON.stringify(merged), existing.id]);
      return;
    }
  }

  run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority, attempts, max_attempts)
     VALUES (?, ?, ?, 'PENDING', 5, 0, 3)`,
    [uuid(), jobType, JSON.stringify(payload)]
  );
}

export function previewMapping(
  profileId: string,
  samplePayload: any
): { success: boolean; normalized?: Record<string, any>; error?: string } {
  const repair = queryOne<any>("SELECT configuration FROM mapping_repairs WHERE profile_id = ?", [profileId]);
  if (repair) {
    const result = evaluateRepair(JSON.parse(repair.configuration), samplePayload, repairSignals());
    return { success: result.success, normalized: result.normalized, ...(result.success ? {} : { error: result.errors.join("; ") }) };
  }
  const profile = queryOne<{ id: string; canonical_schema_version: string }>(
    "SELECT id, canonical_schema_version FROM mapping_profiles WHERE id = ?",
    [profileId]
  );
  if (!profile) {
    return { success: false, error: "Mapping profile not found" };
  }

  const rules = query<any>(
    "SELECT mr.*, cs.name as signal_name, cs.data_type, cs.valid_range_min, cs.valid_range_max FROM mapping_rules mr JOIN canonical_signals cs ON mr.destination_signal_id = cs.id WHERE mr.mapping_profile_id = ?",
    [profileId]
  );

  const normalized: Record<string, any> = {};
  for (const rule of rules) {
    const rawVal = getNestedValue(samplePayload, rule.source_field_path);
    if (rawVal === undefined || rawVal === null) continue;
    let val = rawVal;
    if (rule.conversion_type === "MPH_TO_KMH") val = Number(val) * 1.60934;
    else if (rule.conversion_type === "FRACTION_TO_PERCENT") val = Number(val) * 100;
    else if (rule.conversion_type === "MILES_TO_KM") val = Number(val) * 1.60934;
    else if (rule.conversion_type === "ENUM_MAP" && rule.enum_mapping) {
      try {
        const m = JSON.parse(rule.enum_mapping);
        val = m[String(val)] ?? val;
      } catch {}
    }
    normalized[rule.signal_name] = val;
  }

  return { success: true, normalized };
}

export function runMappingTests(profileId: string): { total: number; passed: number; results: any[] } {
  const testCases = query<any>(
    "SELECT * FROM mapping_test_cases WHERE mapping_profile_id = ?",
    [profileId]
  );

  const results: any[] = [];
  let passed = 0;

  for (const tc of testCases) {
    let input: any;
    let expected: any;
    try {
      input = JSON.parse(tc.raw_input);
      expected = JSON.parse(tc.expected_output);
    } catch {
      results.push({ id: tc.id, passed: false, error: "Invalid test case JSON" });
      continue;
    }

    const preview = previewMapping(profileId, input);
    let ok = preview.success;
    if (ok && preview.normalized) {
      for (const [k, v] of Object.entries(expected)) {
        if (typeof v === "number") {
          if (Math.abs((preview.normalized[k] ?? 0) - v) > 0.05) ok = false;
        } else if (preview.normalized[k] !== v) {
          ok = false;
        }
      }
    } else {
      ok = false;
    }

    if (ok) passed++;
    results.push({ id: tc.id, passed: ok });
  }

  return { total: testCases.length, passed, results };
}

export function replayEvents(mappingProfileId: string, selectionCriteria?: any): { jobId: string } {
  const profile = queryOne<{ id: string; status: string; oem_format_version_id: string }>(
    "SELECT id, status, oem_format_version_id FROM mapping_profiles WHERE id = ?",
    [mappingProfileId]
  );
  if (!profile) {
    throw new Error("Mapping profile not found");
  }

  const jobId = uuid();
  const fleetId = selectionCriteria?.fleet_id || null;
  const incidentId = selectionCriteria?.incident_id || null;

  run(
    `INSERT INTO replay_jobs (id, mapping_profile_id, fleet_id, incident_id, selection_criteria, status, progress_pct, total_events, processed_events, error_events)
     VALUES (?, ?, ?, ?, ?, 'PENDING', 0, 0, 0, 0)`,
    [jobId, mappingProfileId, fleetId, incidentId, JSON.stringify(selectionCriteria || {})]
  );

  run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority, attempts, max_attempts)
     VALUES (?, 'REPLAY_JOB', ?, 'PENDING', 3, 0, 3)`,
    [uuid(), JSON.stringify({ jobId, mappingProfileId })]
  );

  return { jobId };
}

export function runReplayJob(jobId: string, mappingProfileId: string): void {
  try {
    const profile = queryOne<{ oem_format_version_id: string; status: string }>(
      "SELECT oem_format_version_id, status FROM mapping_profiles WHERE id = ?",
      [mappingProfileId]
    );
    if (!profile) {
      run("UPDATE replay_jobs SET status = 'FAILED', final_outcome = 'FAILED', error_message = 'Mapping profile not found', completed_at = datetime('now') WHERE id = ?", [jobId]);
      return;
    }

    const oemFormat = queryOne<{ oem_id: string; format_version: string }>(
      "SELECT oem_id, format_version FROM oem_format_versions WHERE id = ?",
      [profile.oem_format_version_id]
    );
    if (!oemFormat) {
      run("UPDATE replay_jobs SET status = 'FAILED', final_outcome = 'FAILED', error_message = 'Format version not found', completed_at = datetime('now') WHERE id = ?", [jobId]);
      return;
    }

    const jobRow = queryOne<{ selection_criteria: string; fleet_id: string; incident_id: string }>(
      "SELECT selection_criteria, fleet_id, incident_id FROM replay_jobs WHERE id = ?",
      [jobId]
    );
    const criteria = jobRow ? JSON.parse(jobRow.selection_criteria || "{}") : {};
    const targetFleetId = jobRow?.fleet_id || criteria.fleet_id;
    const targetIncidentId = jobRow?.incident_id || criteria.incident_id;

    run("UPDATE replay_jobs SET status = 'RUNNING', started_at = datetime('now') WHERE id = ?", [jobId]);

    let rawEventsSql = `
      SELECT DISTINCT re.*
      FROM raw_events re
      JOIN oem_connections oc ON re.connection_id = oc.id
    `;
    const params: unknown[] = [];

    if (targetIncidentId) {
      rawEventsSql += " JOIN quarantine_records qr ON qr.raw_event_id = re.id AND qr.incident_id = ? ";
      params.push(targetIncidentId);
    }

    rawEventsSql += " WHERE re.processing_status = 'QUARANTINED' ";

    if (targetFleetId) {
      rawEventsSql += " AND re.fleet_id = ? ";
      params.push(targetFleetId);
    }

    rawEventsSql += " AND oc.oem_id = ? ";
    params.push(oemFormat.oem_id);

    if (criteria.connection_id) {
      rawEventsSql += " AND re.connection_id = ?";
      params.push(criteria.connection_id);
    }

    if (Array.isArray(criteria.raw_event_ids) && criteria.raw_event_ids.length > 0) {
      const placeholders = criteria.raw_event_ids.map(() => "?").join(",");
      rawEventsSql += ` AND re.id IN (${placeholders}) `;
      params.push(...criteria.raw_event_ids);
    }

    rawEventsSql += " ORDER BY re.recorded_at ASC ";

    const rawEvents = query<RawEvent>(rawEventsSql, params);
    let processed = 0;
    let error = 0;
    const total = rawEvents.length;

    run("UPDATE replay_jobs SET total_events = ? WHERE id = ?", [total, jobId]);

    for (const evt of rawEvents) {
      const freshCheck = queryOne<{ processing_status: string }>(
        "SELECT processing_status FROM raw_events WHERE id = ?",
        [evt.id]
      );
      if (freshCheck && freshCheck.processing_status === "PROCESSED") {
        continue;
      }

      try {
        const quarantineRecord = findQuarantineRecordByRawEvent(evt.id);
        const res = processRawEvent(evt.id, mappingProfileId, jobId);
        if (res.status === "PROCESSED") {
          const mappingRow = queryOne<{ vehicle_id: string }>(
            "SELECT vehicle_id FROM vehicle_source_mappings WHERE connection_id = ? AND oem_vehicle_id = ?",
            [evt.connection_id, evt.source_vehicle_id]
          );
          let projectionFailed = false;
          let projError = "";
          if (mappingRow?.vehicle_id) {
            const projRes = buildProjectionsForVehicle(mappingRow.vehicle_id);
            if (projRes.errors && projRes.errors.length > 0) {
              projectionFailed = true;
              projError = projRes.errors.join("; ");
            }
          }
          if (projectionFailed) {
            error++;
            if (quarantineRecord) {
              markQuarantineRecordReplayFailed(quarantineRecord.id, `Projection failed: ${projError}`);
            }
          } else {
            if (quarantineRecord) {
              resolveQuarantineRecord(quarantineRecord.id);
            }
            processed++;
          }
        } else {
          error++;
          if (quarantineRecord) {
            markQuarantineRecordReplayFailed(quarantineRecord.id, res.message || "Replay normalization failed");
          }
        }
      } catch (err: any) {
        error++;
        const quarantineRecord = findQuarantineRecordByRawEvent(evt.id);
        if (quarantineRecord) {
          markQuarantineRecordReplayFailed(quarantineRecord.id, err.message || "Replay error");
        }
      }

      const progress = total > 0 ? Math.round(((processed + error) / total) * 100) : 100;
      run(
        `UPDATE replay_jobs
         SET processed_events = ?, error_events = ?, progress_pct = ?
         WHERE id = ?`,
        [processed, error, progress, jobId]
      );
    }

    let finalOutcome = "SUCCESS";
    if (total === 0) {
      finalOutcome = "NO_EVENTS";
    } else if (error > 0 && processed > 0) {
      finalOutcome = "PARTIAL_SUCCESS";
    } else if (error > 0 && processed === 0) {
      finalOutcome = "FAILED";
    }

    run(
      `UPDATE replay_jobs
       SET status = 'COMPLETED',
           final_outcome = ?,
           total_events = ?,
           processed_events = ?,
           error_events = ?,
           progress_pct = 100,
           completed_at = datetime('now')
       WHERE id = ?`,
      [finalOutcome, total, processed, error, jobId]
    );
    try {
      if (targetFleetId) {
        recalculateFleetInsights(targetFleetId);
      }
    } catch {}
  } catch (err: any) {
    run(
      `UPDATE replay_jobs
       SET status = 'FAILED',
           final_outcome = 'FAILED',
           error_message = ?,
           completed_at = datetime('now')
       WHERE id = ?`,
      [err.message, jobId]
    );
  }
}
