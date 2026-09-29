import { v4 as uuid } from "uuid";
import { query, queryOne, run, transaction } from "../db/pool.js";

export type FailureCategory =
  | "SCHEMA_CHANGE"
  | "INVALID_VALUE"
  | "MISSING_VEHICLE_MAPPING"
  | "EXPIRED_AUTH"
  | "INFRA_ERROR"
  | "UNSUPPORTED_OEM"
  | "UNKNOWN_FORMAT";

const RETRYABLE_CATEGORIES: FailureCategory[] = ["INFRA_ERROR"];

export function categorizeFailure(reason: string): FailureCategory {
  const r = reason.toLowerCase();
  if (r.includes("unknown format") || r.includes("format version") || r.includes("schema") || r.includes("unexpected structure")) {
    return "SCHEMA_CHANGE";
  }
  if (r.includes("invalid number") || r.includes("below min") || r.includes("above max") || r.includes("invalid value") || r.includes("type error")) {
    return "INVALID_VALUE";
  }
  if (r.includes("vehicle not mapped") || r.includes("vehicle id not found") || r.includes("not mapped")) {
    return "MISSING_VEHICLE_MAPPING";
  }
  if (r.includes("expired") || r.includes("unauthori") || r.includes("auth")) {
    return "EXPIRED_AUTH";
  }
  if (r.includes("unsupported oem")) {
    return "UNSUPPORTED_OEM";
  }
  if (r.includes("timeout") || r.includes("connection refused") || r.includes("unavailable")) {
    return "INFRA_ERROR";
  }
  return "SCHEMA_CHANGE";
}

export function isRetryable(category: FailureCategory): boolean {
  return RETRYABLE_CATEGORIES.includes(category);
}

export interface CreateQuarantineRecordParams {
  rawEventId: string;
  fleetId: string;
  connectionId: string;
  oemId: string;
  vehicleId: string | null;
  failureReason: string;
  observedFormat?: string;
  expectedFormat?: string;
}

export function createQuarantineRecord(params: CreateQuarantineRecordParams): string {
  const {
    rawEventId, fleetId, connectionId, oemId, vehicleId,
    failureReason, observedFormat, expectedFormat,
  } = params;

  const category = categorizeFailure(failureReason);

  if (isRetryable(category)) {
    return "";
  }

  const incidentId = findOrCreateIncident({
    fleetId,
    connectionId,
    oemId,
    category,
    failureReason,
    expectedFormat,
    observedFormat,
  });

  const recordId = uuid();
  const now = new Date().toISOString();

  run(
    `INSERT INTO quarantine_records
      (id, raw_event_id, incident_id, fleet_id, connection_id, oem_id, vehicle_id,
       failure_category, expected_format, observed_format, failure_detail,
       first_failure_at, latest_attempt_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNRESOLVED')`,
    [recordId, rawEventId, incidentId || null, fleetId, connectionId, oemId,
     vehicleId, category, expectedFormat || null, observedFormat || null,
     failureReason, now, now]
  );

  if (incidentId) {
    updateIncidentCounts(incidentId);
  }

  return recordId;
}

interface FindOrCreateIncidentParams {
  fleetId: string;
  connectionId: string;
  oemId: string;
  category: FailureCategory;
  failureReason: string;
  expectedFormat?: string;
  observedFormat?: string;
}

function findOrCreateIncident(params: FindOrCreateIncidentParams): string {
  const { fleetId, connectionId, oemId, category, failureReason, expectedFormat, observedFormat } = params;

  const existing = queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM quarantine_incidents
     WHERE fleet_id = ? AND connection_id = ? AND failure_category = ?
       AND status NOT IN ('RESOLVED')
     ORDER BY created_at DESC LIMIT 1`,
    [fleetId, connectionId, category]
  );

  if (existing) {
    const now = new Date().toISOString();
    run(
      `UPDATE quarantine_incidents SET latest_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, existing.id]
    );
    return existing.id;
  }

  const incidentId = uuid();
  const now = new Date().toISOString();
  const title = buildIncidentTitle(category, oemId, failureReason, expectedFormat, observedFormat);
  const staleProjections = determineStaleProjections(category);

  run(
    `INSERT INTO quarantine_incidents
      (id, fleet_id, oem_id, connection_id, title, description, failure_category,
       first_failure_at, latest_at, status, stale_projections)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNRESOLVED', ?)`,
    [incidentId, fleetId, oemId, connectionId, title, failureReason, category,
     now, now, JSON.stringify(staleProjections)]
  );

  return incidentId;
}

function buildIncidentTitle(
  category: FailureCategory,
  oemId: string,
  reason: string,
  expectedFormat?: string,
  observedFormat?: string
): string {
  const oemName = oemId.replace("oem_", "").replace(/_/g, " ");
  switch (category) {
    case "SCHEMA_CHANGE":
      if (observedFormat && expectedFormat) {
        return `${oemName} format changed – expected ${expectedFormat}, received ${observedFormat}`;
      }
      return `${oemName} event format does not match any known mapping`;
    case "INVALID_VALUE":
      return `${oemName} is sending out-of-range sensor values`;
    case "MISSING_VEHICLE_MAPPING":
      return `Vehicles from ${oemName} are not registered in this fleet`;
    case "EXPIRED_AUTH":
      return `${oemName} account authorisation has expired`;
    case "INFRA_ERROR":
      return `Temporary connectivity issue receiving data from ${oemName}`;
    case "UNSUPPORTED_OEM":
      return `${oemName} is not yet supported for data ingestion`;
    default:
      return `Data issue from ${oemName}: ${reason.slice(0, 80)}`;
  }
}

function determineStaleProjections(category: FailureCategory): string[] {
  switch (category) {
    case "SCHEMA_CHANGE":
    case "UNKNOWN_FORMAT":
      return ["location", "trips", "health", "alerts"];
    case "INVALID_VALUE":
      return ["health", "alerts"];
    case "MISSING_VEHICLE_MAPPING":
      return ["location", "trips", "health"];
    case "EXPIRED_AUTH":
      return ["location", "trips", "health"];
    default:
      return [];
  }
}

function updateIncidentCounts(incidentId: string): void {
  const counts = queryOne<{ unresolved: number; vehicles: number }>(
    `SELECT
       COUNT(*) as unresolved,
       COUNT(DISTINCT CASE WHEN vehicle_id IS NOT NULL THEN vehicle_id END) as vehicles
     FROM quarantine_records
     WHERE incident_id = ? AND status = 'UNRESOLVED'`,
    [incidentId]
  );

  if (counts) {
    run(
      `UPDATE quarantine_incidents
       SET unresolved_event_count = ?, affected_vehicle_count = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [counts.unresolved, counts.vehicles, incidentId]
    );
  }
}

export function acknowledgeIncident(incidentId: string, acknowledgedBy: string): boolean {
  const incident = queryOne<{ id: string }>(
    "SELECT id FROM quarantine_incidents WHERE id = ?",
    [incidentId]
  );
  if (!incident) return false;

  run(
    `UPDATE quarantine_incidents
     SET acknowledged_by = ?, acknowledged_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
    [acknowledgedBy, incidentId]
  );
  return true;
}

export function markIncidentMappingReady(incidentId: string): void {
  run(
    `UPDATE quarantine_incidents SET status = 'MAPPING_READY', updated_at = datetime('now') WHERE id = ?`,
    [incidentId]
  );
}

export function markIncidentReplaying(incidentId: string): void {
  run(
    `UPDATE quarantine_incidents SET status = 'REPLAYING', updated_at = datetime('now') WHERE id = ?`,
    [incidentId]
  );
  run(
    `UPDATE quarantine_records SET status = 'REPLAYING', updated_at = datetime('now') WHERE incident_id = ? AND status IN ('UNRESOLVED', 'MAPPING_READY')`,
    [incidentId]
  );
}

export function resolveQuarantineRecord(recordId: string): void {
  run(
    `UPDATE quarantine_records SET status = 'RESOLVED', updated_at = datetime('now') WHERE id = ?`,
    [recordId]
  );

  const record = queryOne<{ incident_id: string }>(
    "SELECT incident_id FROM quarantine_records WHERE id = ?",
    [recordId]
  );
  if (record?.incident_id) {
    updateIncidentCounts(record.incident_id);
    const remaining = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM quarantine_records WHERE incident_id = ? AND status NOT IN ('RESOLVED')",
      [record.incident_id]
    );
    if (remaining?.count === 0) {
      run(
        `UPDATE quarantine_incidents SET status = 'RESOLVED', updated_at = datetime('now') WHERE id = ?`,
        [record.incident_id]
      );
    }
  }
}

export function markQuarantineRecordReplayFailed(recordId: string, errorDetail: string): void {
  run(
    `UPDATE quarantine_records
     SET status = 'REPLAY_FAILED', failure_detail = ?, latest_attempt_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
    [errorDetail, recordId]
  );

  const record = queryOne<{ incident_id: string }>(
    "SELECT incident_id FROM quarantine_records WHERE id = ?",
    [recordId]
  );
  if (record?.incident_id) {
    run(
      `UPDATE quarantine_incidents SET status = 'REPLAY_FAILED', updated_at = datetime('now') WHERE id = ?`,
      [record.incident_id]
    );
  }
}

export function getIncidents(fleetId: string, status?: string): any[] {
  let sql = `
    SELECT qi.*,
           so.name as oem_name,
           oc.label as connection_label
    FROM quarantine_incidents qi
    LEFT JOIN supported_oems so ON qi.oem_id = so.id
    LEFT JOIN oem_connections oc ON qi.connection_id = oc.id
    WHERE qi.fleet_id = ?
  `;
  const params: unknown[] = [fleetId];
  if (status) {
    sql += " AND qi.status = ?";
    params.push(status);
  }
  sql += " ORDER BY qi.latest_at DESC";
  return query(sql, params);
}

export function getIncidentDetail(incidentId: string): any {
  return queryOne(
    `SELECT qi.*,
            so.name as oem_name,
            oc.label as connection_label
     FROM quarantine_incidents qi
     LEFT JOIN supported_oems so ON qi.oem_id = so.id
     LEFT JOIN oem_connections oc ON qi.connection_id = oc.id
     WHERE qi.id = ?`,
    [incidentId]
  );
}

export function getAffectedVehicles(incidentId: string): any[] {
  return query(
    `SELECT DISTINCT v.id, v.vin, v.label, v.data_status,
            COUNT(qr.id) as quarantined_count,
            MAX(qr.latest_attempt_at) as last_failure_at,
            v.last_data_at as last_valid_data_at
     FROM quarantine_records qr
     JOIN vehicles v ON qr.vehicle_id = v.id
     WHERE qr.incident_id = ?
     GROUP BY v.id`,
    [incidentId]
  );
}

export function getQuarantineRecords(filters: {
  fleetId?: string;
  incidentId?: string;
  vehicleId?: string;
  status?: string;
  limit?: number;
}): any[] {
  let sql = `
    SELECT qr.*, re.payload_hash, re.recorded_at as raw_recorded_at
    FROM quarantine_records qr
    JOIN raw_events re ON qr.raw_event_id = re.id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (filters.fleetId) { sql += " AND qr.fleet_id = ?"; params.push(filters.fleetId); }
  if (filters.incidentId) { sql += " AND qr.incident_id = ?"; params.push(filters.incidentId); }
  if (filters.vehicleId) { sql += " AND qr.vehicle_id = ?"; params.push(filters.vehicleId); }
  if (filters.status) { sql += " AND qr.status = ?"; params.push(filters.status); }
  sql += " ORDER BY qr.latest_attempt_at DESC";
  if (filters.limit) { sql += ` LIMIT ${filters.limit}`; }
  return query(sql, params);
}

export function findQuarantineRecordByRawEvent(rawEventId: string): any {
  return queryOne(
    "SELECT * FROM quarantine_records WHERE raw_event_id = ?",
    [rawEventId]
  );
}

export function getIncidentForConnection(connectionId: string, category: FailureCategory): any {
  return queryOne(
    `SELECT * FROM quarantine_incidents
     WHERE connection_id = ? AND failure_category = ? AND status NOT IN ('RESOLVED')
     ORDER BY created_at DESC LIMIT 1`,
    [connectionId, category]
  );
}
