import { v4 as uuid } from "uuid";
import { query, queryOne, run, transaction } from "../db/pool.js";
import { AppError } from "../middleware/error.js";
import { redactSensitive } from "./vault.service.js";
import { markIncidentMappingReady } from "./quarantine.service.js";
import { inspectFields, evaluateRepair, matchesRepairPayload, REPAIR_CONVERSIONS, type RepairConfiguration, type CanonicalSignal } from "./mapping-repair.engine.js";

export function repairSignals(): CanonicalSignal[] { return query("SELECT * FROM canonical_signals ORDER BY name"); }
export function repairIncident(fleetId: string, incidentId: string): any {
  const incident = queryOne("SELECT qi.*, so.name AS oem_name FROM quarantine_incidents qi LEFT JOIN supported_oems so ON so.id = qi.oem_id WHERE qi.id = ? AND qi.fleet_id = ?", [incidentId, fleetId]);
  if (!incident) throw new AppError(404, "NOT_FOUND", "Data issue not found");
  if (!incident.connection_id) throw new AppError(400, "VALIDATION_ERROR", "This issue has no OEM connection to repair");
  return incident;
}
function sampleRows(fleetId: string, incidentId: string, limit = 60): any[] {
  // Oldest and newest examples expose mixed historical formats without loading the whole backlog.
  const base = `SELECT DISTINCT re.* FROM raw_events re JOIN quarantine_records qr ON qr.raw_event_id = re.id WHERE qr.incident_id = ? AND re.fleet_id = ? AND re.processing_status = 'QUARANTINED'`;
  const oldest = query(`${base} ORDER BY re.recorded_at, re.id LIMIT ?`, [incidentId, fleetId, Math.ceil(limit / 2)]);
  const newest = query(`${base} ORDER BY re.recorded_at DESC, re.id DESC LIMIT ?`, [incidentId, fleetId, Math.floor(limit / 2)]);
  return [...new Map([...oldest, ...newest].map(row => [row.id, row])).values()];
}
function parsePayload(payload: string): any { try { return JSON.parse(payload); } catch { return null; } }
export function repairContext(fleetId: string, incidentId: string) {
  const incident = repairIncident(fleetId, incidentId);
  const rows = sampleRows(fleetId, incidentId);
  const samples = rows.map(row => ({ id: row.id, recorded_at: row.recorded_at, source_vehicle_id: row.source_vehicle_id, payload: redactSensitive(parsePayload(row.payload)) }));
  const paths = [...new Map(samples.flatMap(sample => inspectFields(sample.payload)).map(field => [field.path, field])).values()];
  const existing = queryOne<any>(`SELECT mp.id, mp.mapping_version, mp.status, mr.configuration, mr.revision FROM mapping_repairs mr JOIN mapping_profiles mp ON mp.id = mr.profile_id WHERE mr.fleet_id = ? AND mr.incident_id = ? ORDER BY mp.rowid DESC LIMIT 1`, [fleetId, incidentId]);
  const templates = query<any>(`SELECT mp.id, mp.mapping_version, ofv.format_version FROM mapping_profiles mp JOIN oem_format_versions ofv ON ofv.id = mp.oem_format_version_id WHERE ofv.oem_id = ? AND mp.status = 'ACTIVE' AND NOT EXISTS(SELECT 1 FROM mapping_repairs mr WHERE mr.profile_id = mp.id)`, [incident.oem_id]).map(profile => ({ ...profile, rules: query<any>("SELECT * FROM mapping_rules WHERE mapping_profile_id = ?", [profile.id]) }));
  const count = queryOne<any>(`SELECT COUNT(DISTINCT re.id) AS total FROM raw_events re JOIN quarantine_records qr ON qr.raw_event_id = re.id WHERE qr.incident_id = ? AND re.fleet_id = ? AND re.processing_status = 'QUARANTINED'`, [incidentId, fleetId])?.total || 0;
  const latestJob = queryOne<any>("SELECT * FROM replay_jobs WHERE fleet_id = ? AND incident_id = ? ORDER BY rowid DESC LIMIT 1", [fleetId, incidentId]);
  const lastAccepted = queryOne<any>(`SELECT ne.mapping_profile_id, re.payload FROM normalized_events ne JOIN raw_events re ON re.id = ne.raw_event_id WHERE re.fleet_id = ? AND re.connection_id = ? AND re.processing_status = 'PROCESSED' ORDER BY re.recorded_at DESC, re.rowid DESC LIMIT 1`, [fleetId, incident.connection_id]);
  const lastRepair = lastAccepted && queryOne<any>('SELECT configuration FROM mapping_repairs WHERE profile_id = ? AND fleet_id = ? AND connection_id = ?', [lastAccepted.mapping_profile_id, fleetId, incident.connection_id]);
  const baseline = lastAccepted ? { profile_id: lastAccepted.mapping_profile_id, sample: redactSensitive(parsePayload(lastAccepted.payload)), rules: lastRepair ? JSON.parse(lastRepair.configuration).rules : query<any>('SELECT * FROM mapping_rules WHERE mapping_profile_id = ?', [lastAccepted.mapping_profile_id]).map(rule => ({ signal_id: rule.destination_signal_id, sources: [rule.source_field_path], conversion: rule.conversion_type, required: rule.destination_signal_id === 'sig_event_time', ...(rule.enum_mapping ? { enum_map: JSON.parse(rule.enum_mapping) } : {}) })) } : null;
  const signals = repairSignals();
  const failureText = query<any>("SELECT DISTINCT failure_detail FROM quarantine_records WHERE fleet_id = ? AND incident_id = ? AND status != 'RESOLVED' LIMIT 60", [fleetId, incidentId]).map(row => row.failure_detail || '').join('\n');
  const affected_signals = signals.filter(signal => new RegExp(`\\b${signal.name}\\b`, 'i').test(failureText)).map(signal => ({ id: signal.id, name: signal.name, data_type: signal.data_type }));
  const conflicts = rows.filter(row => queryOne("SELECT id FROM quarantine_records WHERE raw_event_id = ? AND failure_category = 'IDEMPOTENCY_CONFLICT'", [row.id])).map(row => {
    const previous = queryOne<any>("SELECT * FROM raw_events WHERE fleet_id = ? AND connection_id = ? AND source_event_id = ? AND id != ? AND payload_hash != ? ORDER BY rowid LIMIT 1", [fleetId, row.connection_id, row.source_event_id, row.id, row.payload_hash]);
    const original = redactSensitive(parsePayload(previous?.payload || 'null'));
    const incoming = redactSensitive(parsePayload(row.payload));
    const fields = [...new Set([...inspectFields(original), ...inspectFields(incoming)].map(field => field.path))];
    const valueAt = (payload: any, path: string) => payload && Object.hasOwn(payload, path) ? payload[path] : path.split('.').reduce((value, part) => value?.[part], payload);
    return { id: row.id, reference: row.source_event_id, vehicle: row.source_vehicle_id,
      previous: previous ? { received_at: previous.recorded_at, vehicle: previous.source_vehicle_id, status: previous.processing_status } : null,
      received_at: row.recorded_at,
      differences: fields.map(path => ({ field: path, saved: valueAt(original, path) ?? null, incoming: valueAt(incoming, path) ?? null })).filter(field => JSON.stringify(field.saved) !== JSON.stringify(field.incoming)) };
  });
  const connection = queryOne<any>('SELECT status FROM oem_connections WHERE id = ? AND fleet_id = ?', [incident.connection_id, fleetId]);
  const nextAction = conflicts.length === rows.length && rows.length ? 'provider' : connection?.status === 'EXPIRED' ? 'reconnect' : incident.failure_category === 'MISSING_VEHICLE_MAPPING' ? 'vehicle' : rows.length && rows.every(row => { const payload = parsePayload(row.payload); return !payload || typeof payload !== 'object' || Array.isArray(payload); }) ? 'provider' : 'readings';
  return { incident, samples, baseline, affected_signals, conflicts, nextAction, paths: paths.filter(field => field.example !== "[REDACTED]"), signals, templates, total: count, latestJob, existing: existing ? { ...existing, configuration: JSON.parse(existing.configuration) } : null };
}
const validPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !value.split(".").some(part => !part || ["__proto__", "prototype", "constructor"].includes(part) || redactSensitive({ [part]: "check" })[part] === "[REDACTED]");
export function validateRepairConfiguration(input: any): RepairConfiguration {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) throw new AppError(400, "VALIDATION_ERROR", "Give this mapping a name (up to 100 characters)");
  if (!["invalid_only", "matching", "replay_only"].includes(input.live_mode)) throw new AppError(400, "VALIDATION_ERROR", "Choose where the mapping will apply");
  if (!Array.isArray(input.rules) || input.rules.length < 2 || input.rules.length > 50) throw new AppError(400, "VALIDATION_ERROR", "Map event time and at least one measurement");
  const signals = repairSignals();
  const seen = new Set<string>();
  for (const rule of input.rules) {
    if (!signals.some(signal => signal.id === rule.signal_id) || seen.has(rule.signal_id)) throw new AppError(400, "VALIDATION_ERROR", "Each destination measurement can be mapped once");
    seen.add(rule.signal_id);
    if (!Array.isArray(rule.sources) || rule.sources.length < 1 || rule.sources.length > 5 || !rule.sources.every(validPath)) throw new AppError(400, "VALIDATION_ERROR", "Select a source field; up to five fallback fields are supported");
    if (!REPAIR_CONVERSIONS.includes(rule.conversion) || typeof rule.required !== "boolean") throw new AppError(400, "VALIDATION_ERROR", "Invalid conversion or missing-field setting");
    if (rule.signal_id === "sig_event_time" && !rule.required) throw new AppError(400, "VALIDATION_ERROR", "Event time must be required");
    if (rule.conversion === "ENUM_MAP" && (!rule.enum_map || typeof rule.enum_map !== "object" || Array.isArray(rule.enum_map) || Object.keys(rule.enum_map).length > 100 || Object.values(rule.enum_map).some(value => typeof value !== "string"))) throw new AppError(400, "VALIDATION_ERROR", "Provide a value mapping for each OEM code");
    if (rule.conversion === "SCALE_OFFSET" && (!Number.isFinite(rule.scale) || !Number.isFinite(rule.offset))) throw new AppError(400, "VALIDATION_ERROR", "Scale and offset must be finite numbers");
  }
  if (!seen.has("sig_event_time")) throw new AppError(400, "VALIDATION_ERROR", "Map the originating event timestamp");
  if (input.discriminator && (!validPath(input.discriminator.path) || typeof input.discriminator.value !== "string" || !input.discriminator.value || input.discriminator.value.length > 100)) throw new AppError(400, "VALIDATION_ERROR", "Select a format/version field and its expected value");
  if (input.field_decisions && (typeof input.field_decisions !== 'object' || Array.isArray(input.field_decisions) || Object.keys(input.field_decisions).length > 200 || Object.entries(input.field_decisions).some(([source, decision]) => !validPath(source) || !['IGNORE', 'REMOVED'].includes(String(decision)) || input.rules.some((rule: any) => rule.sources.includes(source))))) throw new AppError(400, 'VALIDATION_ERROR', 'A field can be used or left unused, not both');
  return { name: input.name.trim(), rules: input.rules, live_mode: input.live_mode, ...(input.discriminator ? { discriminator: input.discriminator } : {}), ...(input.field_decisions ? { field_decisions: input.field_decisions } : {}) };
}
export function repairProfile(fleetId: string, id: string): any {
  const row = queryOne<any>("SELECT mr.*, mp.status FROM mapping_repairs mr JOIN mapping_profiles mp ON mp.id = mr.profile_id WHERE mr.profile_id = ? AND mr.fleet_id = ?", [id, fleetId]);
  if (!row) throw new AppError(404, "NOT_FOUND", "Mapping repair not found");
  return { ...row, configuration: JSON.parse(row.configuration) as RepairConfiguration };
}
export function saveRepair(fleetId: string, incidentId: string, input: any, userId: string, profileId?: string, expectedRevision?: number) {
  const incident = repairIncident(fleetId, incidentId);
  const configuration = validateRepairConfiguration(input);
  return transaction(() => {
    if (profileId) {
      const profile = repairProfile(fleetId, profileId);
      if (profile.incident_id !== incidentId || profile.status !== "DRAFT") throw new AppError(409, "CONFLICT", "Published mappings are immutable; create a new version");
      if (profile.revision !== expectedRevision) throw new AppError(409, "CONFLICT", "This draft changed in another session; reopen it before editing");
      run("UPDATE mapping_repairs SET configuration = ?, validation_report = NULL, revision = revision + 1 WHERE profile_id = ?", [JSON.stringify(configuration), profileId]);
      return { id: profileId, revision: profile.revision + 1 };
    }
    const id = uuid(); const formatId = uuid();
    run("INSERT INTO oem_format_versions(id, oem_id, event_type, format_version, expected_structure) VALUES (?, ?, 'telemetry', ?, '{}')", [formatId, incident.oem_id, `repair_${id}`]);
    run("INSERT INTO mapping_profiles(id, oem_format_version_id, mapping_version, canonical_schema_version, status) VALUES (?, ?, ?, '1.0', 'DRAFT')", [id, formatId, configuration.name]);
    run("INSERT INTO mapping_repairs(profile_id, fleet_id, connection_id, incident_id, configuration, created_by) VALUES (?, ?, ?, ?, ?, ?)", [id, fleetId, incident.connection_id, incidentId, JSON.stringify(configuration), userId]);
    return { id, revision: 1 };
  });
}
export function testRepair(fleetId: string, id: string) {
  const profile = repairProfile(fleetId, id);
  const signals = repairSignals();
  const rows = sampleRows(fleetId, profile.incident_id);
  const results = rows.map(row => {
    const result = evaluateRepair(profile.configuration, parsePayload(row.payload), signals);
    const connection = queryOne<any>("SELECT status FROM oem_connections WHERE id = ?", [row.connection_id]);
    if (connection?.status === "EXPIRED") result.errors.push("Reconnect the OEM account before recovery");
    const vehicleMissing = !queryOne("SELECT id FROM vehicle_source_mappings WHERE connection_id = ? AND oem_vehicle_id = ?", [row.connection_id, row.source_vehicle_id]);
    if (vehicleMissing) result.errors.push("Choose the vehicle for these readings in Connections");
    const conflict = queryOne("SELECT id FROM quarantine_records WHERE raw_event_id = ? AND failure_category = 'IDEMPOTENCY_CONFLICT'", [row.id]);
    if (conflict) result.errors.push("This record number was sent with different readings. Download the correction request for your vehicle data provider.");
    result.success = result.errors.length === 0;
    return { id: row.id, nextAction: conflict ? 'provider' : connection?.status === 'EXPIRED' ? 'reconnect' : vehicleMissing ? 'vehicle' : 'readings', ...redactSensitive(result) };
  });
  const regressions = profile.configuration.live_mode === "matching" ? query<any>("SELECT re.id, re.payload, ne.canonical_values FROM raw_events re JOIN normalized_events ne ON ne.raw_event_id = re.id WHERE re.fleet_id = ? AND re.connection_id = ? AND re.processing_status = 'PROCESSED' ORDER BY re.recorded_at DESC LIMIT 20", [fleetId, profile.connection_id]).filter(row => matchesRepairPayload(profile.configuration, parsePayload(row.payload))).map(row => {
    const result = evaluateRepair(profile.configuration, parsePayload(row.payload), signals);
    const before = JSON.parse(row.canonical_values);
    const changes = [...new Set([...Object.keys(before), ...Object.keys(result.normalized)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(result.normalized[key])).map(signal => ({ signal, before: before[signal] ?? null, after: result.normalized[signal] ?? null }));
    return { id: row.id, success: result.success, errors: result.errors, changes };
  }) : [];
  const report = { revision: profile.revision, sampled: results.length, passed: results.filter(row => row.success).length, blocked: results.filter(row => !row.success).length, results, regression_checked: regressions.length, regression_failed: regressions.filter(result => !result.success).length, regression_changed: regressions.filter(result => result.changes.length).length, regressions };
  if (profile.status === "DRAFT") run("UPDATE mapping_repairs SET validation_report = ? WHERE profile_id = ?", [JSON.stringify(report), id]);
  return report;
}
export function publishRepair(fleetId: string, id: string, userId: string, revision: number) {
  return transaction(() => {
    const profile = repairProfile(fleetId, id);
    if (profile.status !== "DRAFT" || profile.revision !== revision) throw new AppError(409, "CONFLICT", "The draft changed or was already published; test the current version");
    const previous = profile.validation_report ? JSON.parse(profile.validation_report) : null;
    if (!previous || previous.revision !== revision) throw new AppError(400, "VALIDATION_ERROR", "Test this draft before publishing");
    const report = testRepair(fleetId, id);
    if (!report.passed || report.regression_failed) throw new AppError(400, "VALIDATION_ERROR", "At least one quarantined example must pass and existing-format tests must not fail");
    run("UPDATE mapping_profiles SET status = 'ACTIVE' WHERE id = ?", [id]);
    run("UPDATE mapping_repairs SET published_by = ?, published_at = datetime('now') WHERE profile_id = ?", [userId, id]);
    markIncidentMappingReady(profile.incident_id);
    return { success: true, report };
  });
}
export function findLiveRepair(fleetId: string, connectionId: string, payload: any, existingFormatValid: boolean): any {
  const profiles = query<any>("SELECT mr.*, mp.status FROM mapping_repairs mr JOIN mapping_profiles mp ON mp.id = mr.profile_id WHERE mr.fleet_id = ? AND mr.connection_id = ? AND mp.status = 'ACTIVE' ORDER BY mr.published_at DESC, mr.rowid DESC", [fleetId, connectionId]);
  for (const profile of profiles) {
    const configuration: RepairConfiguration = JSON.parse(profile.configuration);
    if (configuration.live_mode === "replay_only" || (configuration.live_mode === "invalid_only" && existingFormatValid)) continue;
    if (matchesRepairPayload(configuration, payload)) return { ...profile, configuration };
  }
  return undefined;
}
