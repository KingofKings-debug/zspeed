import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import request from "supertest";
import { app } from "../index.js";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { closeDb, queryOne, query, run } from "../db/pool.js";
import { ingestEvent, replayEvents, runReplayJob } from "../services/ingestion.service.js";
import { loadContractsForOem } from "../services/format-contract.service.js";
import { repairContext, saveRepair, testRepair, publishRepair, repairSignals } from "../services/mapping-repair.service.js";
import { evaluateRepair, type RepairConfiguration } from "../services/mapping-repair.engine.js";

const fleet = "fleet-repair-test", connection = "connection-repair-test", vehicle = "vehicle-repair-test", source = "OEM-REPAIR-1";
let dbPath: string;
const payload = (extra: any = {}) => ({ meta: { timestamp: "2026-10-01T10:00:00Z", version: "r2" }, telemetry: { velocity: "45", battery: "0.75", latitude: "0", longitude: "0", ignition: "running" }, ...extra });
const configuration = (): RepairConfiguration => ({ name: "Renamed telemetry v2", live_mode: "invalid_only", rules: [
  { signal_id: "sig_event_time", sources: ["meta.timestamp"], conversion: "ISO_TIME", required: true },
  { signal_id: "sig_speed", sources: ["telemetry.velocity"], conversion: "MPH_TO_KMH", required: true },
  { signal_id: "sig_soc", sources: ["telemetry.battery"], conversion: "FRACTION_TO_PERCENT", required: false },
  { signal_id: "sig_latitude", sources: ["telemetry.latitude"], conversion: "DIRECT", required: false },
  { signal_id: "sig_longitude", sources: ["telemetry.longitude"], conversion: "DIRECT", required: false },
  { signal_id: "sig_ignition", sources: ["telemetry.ignition"], conversion: "ENUM_MAP", required: false, enum_map: { running: "ON", stopped: "OFF" } },
] });
function addEvent(data = payload(), id = "event-changed") { return ingestEvent(fleet, connection, source, data, id); }
function incidentFor(eventId: string) { return queryOne<any>("SELECT incident_id FROM quarantine_records WHERE raw_event_id = ?", [eventId])!.incident_id as string; }
function draftAndPublish(incident: string, config = configuration()) {
  const draft = saveRepair(fleet, incident, config, "operator");
  testRepair(fleet, draft.id); publishRepair(fleet, draft.id, "operator", draft.revision);
  return draft;
}
beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `zspeed-repair-${Date.now()}-${Math.random()}.db`);
  process.env.OVERRIDE_DB_PATH = dbPath; closeDb(); runMigrations(); seedDatabase();
  run("INSERT INTO fleets(id, name) VALUES (?, 'Repair fleet')", [fleet]);
  run("INSERT INTO oem_connections(id, fleet_id, oem_id, label, status) VALUES (?, ?, 'oem_voltera', 'Test OEM', 'ACTIVE')", [connection, fleet]);
  run("INSERT INTO vehicles(id, fleet_id, vin, data_status) VALUES (?, ?, 'REPAIRVIN00000001', 'NO_CONNECTION')", [vehicle, fleet]);
  run("INSERT INTO vehicle_source_mappings(id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES ('mapping-repair-test', ?, ?, ?, 1)", [vehicle, connection, source]);
});
afterEach(() => { closeDb(); for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + suffix); } catch {} } });

describe("Guided, connection-scoped mapping repairs", () => {
  it("keeps original data and global formats intact through inspect, test, publish and historical replay", () => {
    const event = addEvent(); expect(event.status).toBe("QUARANTINED");
    const incident = incidentFor(event.eventId);
    const original = queryOne<any>("SELECT payload, payload_hash FROM raw_events WHERE id = ?", [event.eventId]);
    const initialContracts = loadContractsForOem("oem_voltera").map(contract => contract.id);
    const context = repairContext(fleet, incident);
    expect(context.paths.map(field => field.path)).toContain("telemetry.velocity");
    const draft = saveRepair(fleet, incident, configuration(), "operator");
    expect(loadContractsForOem("oem_voltera").map(contract => contract.id)).toEqual(initialContracts);
    const report = testRepair(fleet, draft.id);
    expect(report.passed).toBe(1); expect(report.results[0].normalized.vehicle_speed).toBeCloseTo(72.4203);
    expect(queryOne<any>("SELECT COUNT(*) AS count FROM normalized_events WHERE raw_event_id = ?", [event.eventId])!.count).toBe(0);
    publishRepair(fleet, draft.id, "operator", draft.revision);
    const replay = replayEvents(draft.id, { fleet_id: fleet, incident_id: incident, connection_id: connection });
    runReplayJob(replay.jobId, draft.id);
    const job = queryOne<any>("SELECT * FROM replay_jobs WHERE id = ?", [replay.jobId]);
    expect(job.final_outcome).toBe("SUCCESS"); expect(job.processed_events).toBe(1);
    const normalized = queryOne<any>("SELECT * FROM normalized_events WHERE raw_event_id = ?", [event.eventId]);
    expect(normalized.latitude).toBe(0); expect(normalized.longitude).toBe(0);
    expect(JSON.parse(normalized.canonical_values).ignition_status).toBe("ON");
    expect(queryOne("SELECT payload, payload_hash FROM raw_events WHERE id = ?", [event.eventId])).toEqual(original);
    expect(queryOne<any>("SELECT status FROM quarantine_incidents WHERE id = ?", [incident])!.status).toBe("RESOLVED");
    const second = replayEvents(draft.id, { fleet_id: fleet, incident_id: incident }); runReplayJob(second.jobId, draft.id);
    expect(queryOne<any>("SELECT COUNT(*) AS count FROM normalized_events WHERE raw_event_id = ?", [event.eventId])!.count).toBe(1);
    expect(queryOne<any>("SELECT status FROM mapping_profiles WHERE id = 'prof_voltera_v1'")!.status).toBe("ACTIVE");
  });
  it("recovers valid events but retains corrupt GPS without duplicating quarantine records", () => {
    const good = addEvent();
    const bad = addEvent(payload({ telemetry: { velocity: "40", battery: "0.7", latitude: 900, longitude: 20 } }), "bad-gps");
    const incident = incidentFor(good.eventId);
    expect(incidentFor(bad.eventId)).toBe(incident);
    const draft = saveRepair(fleet, incident, configuration(), "operator");
    expect(testRepair(fleet, draft.id)).toMatchObject({ passed: 1, blocked: 1 });
    publishRepair(fleet, draft.id, "operator", draft.revision);
    const replay = replayEvents(draft.id, { fleet_id: fleet, incident_id: incident }); runReplayJob(replay.jobId, draft.id);
    expect(queryOne<any>("SELECT final_outcome FROM replay_jobs WHERE id = ?", [replay.jobId])!.final_outcome).toBe("PARTIAL_SUCCESS");
    expect(queryOne<any>("SELECT processing_status FROM raw_events WHERE id = ?", [bad.eventId])!.processing_status).toBe("QUARANTINED");
    expect(queryOne<any>("SELECT COUNT(*) AS count FROM quarantine_records WHERE raw_event_id = ?", [bad.eventId])!.count).toBe(1);
    expect(queryOne<any>("SELECT unresolved_event_count FROM quarantine_incidents WHERE id = ?", [incident])!.unresolved_event_count).toBe(1);
  });
  it("requires a current successful test and preserves immutable published versions", () => {
    const event = addEvent(); const incident = incidentFor(event.eventId);
    const draft = saveRepair(fleet, incident, configuration(), "operator");
    expect(() => publishRepair(fleet, draft.id, "operator", 1)).toThrow("Test this draft");
    testRepair(fleet, draft.id);
    const updated = saveRepair(fleet, incident, { ...configuration(), name: "New draft" }, "operator", draft.id, 1);
    expect(() => publishRepair(fleet, draft.id, "operator", 1)).toThrow("draft changed");
    expect(() => saveRepair(fleet, incident, configuration(), "operator", draft.id, 1)).toThrow("another session");
    testRepair(fleet, draft.id); publishRepair(fleet, draft.id, "operator", updated.revision);
    expect(() => saveRepair(fleet, incident, configuration(), "operator", draft.id, updated.revision)).toThrow("immutable");
    expect(queryOne<any>("SELECT published_by FROM mapping_repairs WHERE profile_id = ?", [draft.id])!.published_by).toBe("operator");
  });
  it("applies new live formats only to the selected connection and can be disabled", () => {
    const event = addEvent(); const draft = draftAndPublish(incidentFor(event.eventId));
    expect(addEvent(payload({ sample_seq: 2 }), "new-live").status).toBe("PROCESSED");
    run("INSERT INTO oem_connections(id, fleet_id, oem_id, label, status) VALUES ('another-connection', ?, 'oem_voltera', 'Other', 'ACTIVE')", [fleet]);
    expect(ingestEvent(fleet, "another-connection", source, payload(), "other-live").status).toBe("QUARANTINED");
    run("UPDATE mapping_profiles SET status = 'RETIRED' WHERE id = ?", [draft.id]);
    expect(addEvent(payload({ sample_seq: 3 }), "after-disable").status).toBe("QUARANTINED");
  });
  it("supports historical-only recovery without changing live data", () => {
    const event = addEvent(); const incident = incidentFor(event.eventId);
    const draft = draftAndPublish(incident, { ...configuration(), live_mode: "replay_only" });
    expect(addEvent(payload({ sample_seq: 2 }), "still-live-blocked").status).toBe("QUARANTINED");
    const replay = replayEvents(draft.id, { fleet_id: fleet, incident_id: incident }); runReplayJob(replay.jobId, draft.id);
    expect(queryOne<any>("SELECT processed_events FROM replay_jobs WHERE id = ?", [replay.jobId])!.processed_events).toBe(2);
  });
  it("blocks incomplete or broken samples from publication", () => {
    const event = addEvent(payload({ meta: { timestamp: "local time without timezone" } }));
    const incident = incidentFor(event.eventId);
    const draft = saveRepair(fleet, incident, configuration(), "operator");
    expect(testRepair(fleet, draft.id).passed).toBe(0);
    expect(() => publishRepair(fleet, draft.id, "operator", draft.revision)).toThrow("At least one");
    expect(() => saveRepair(fleet, incident, { ...configuration(), rules: configuration().rules.filter(rule => rule.signal_id !== "sig_event_time") }, "operator")).toThrow("timestamp");
  });
  it("rejects cross-fleet access and keeps connector accounts out of repair controls", async () => {
    const event = addEvent(); const incident = incidentFor(event.eventId);
    const draft = saveRepair(fleet, incident, configuration(), "operator");
    await request(app).get(`/api/ingestion/repair/incidents/${incident}`).set("Authorization", "Bearer demo:other-fleet:fleet_manager").expect(404);
    await request(app).post(`/api/ingestion/repair/${draft.id}/test`).set("Authorization", "Bearer demo:other-fleet:platform_admin").expect(404);
    await request(app).post(`/api/ingestion/mappings/${draft.id}/preview`).send({ payload: payload() }).set("Authorization", "Bearer demo:other-fleet:platform_admin").expect(404);
    const list = await request(app).get('/api/ingestion/mappings').set("Authorization", "Bearer demo:other-fleet:platform_admin").expect(200);
    expect(list.body.profiles.some((profile: any) => profile.id === draft.id)).toBe(false);
    await request(app).get(`/api/ingestion/repair/incidents/${incident}`).set("Authorization", `Bearer demo:${fleet}:connector`).expect(403);
    await request(app).post(`/api/ingestion/repair/${draft.id}/publish`).send({ revision: 1 }).set("Authorization", `Bearer demo:${fleet}:fleet_manager`).expect(400);
    await request(app).post(`/api/ingestion/repair/${draft.id}/test`).set("Authorization", `Bearer demo:${fleet}:fleet_manager`).expect(200);
    await request(app).post(`/api/ingestion/repair/${draft.id}/publish`).send({ revision: 1 }).set("Authorization", `Bearer demo:${fleet}:fleet_manager`).expect(200);
    const first = await request(app).post(`/api/ingestion/repair/${draft.id}/replay`).set("Authorization", `Bearer demo:${fleet}:fleet_manager`).expect(200);
    const second = await request(app).post(`/api/ingestion/repair/${draft.id}/replay`).set("Authorization", `Bearer demo:${fleet}:fleet_manager`).expect(200);
    expect(second.body.jobId).toBe(first.body.jobId);
    await request(app).post(`/api/ingestion/repair/${draft.id}/disable`).set("Authorization", `Bearer demo:${fleet}:fleet_manager`).expect(409);
    expect(queryOne<any>("SELECT selection_criteria FROM replay_jobs WHERE id = ?", [first.body.jobId])!.selection_criteria).toContain(incident);
    await request(app).post(`/api/ingestion/mappings/${draft.id}/publish`).set("Authorization", `Bearer demo:${fleet}:platform_admin`).expect(400);
  });
  it("shows changed outputs for recognized formats before replacing their live mapping", () => {
    const old = { timestamp: "2026-10-01T09:00:00Z", speed_mph: 50, charge_fraction: .7, lat: 0, lon: 0 };
    expect(addEvent(old, 'old-format').status).toBe('PROCESSED');
    const changed = addEvent();
    const config = configuration(); config.live_mode = 'matching';
    config.rules[0].sources.push('timestamp'); config.rules[1].sources.push('speed_mph'); config.rules[1].conversion = 'DIRECT';
    const draft = saveRepair(fleet, incidentFor(changed.eventId), config, 'operator');
    const report = testRepair(fleet, draft.id);
    expect(report.regression_checked).toBe(1); expect(report.regression_changed).toBe(1);
    expect(report.regressions[0].changes.find(change => change.signal === 'vehicle_speed')).toMatchObject({ before: 80.467, after: 50 });
  });
  it("does not publish a mapping as a remedy for conflicting reused event IDs", () => {
    addEvent();
    const conflict = addEvent(payload({ sequence: 99 }), 'event-changed');
    const draft = saveRepair(fleet, incidentFor(conflict.eventId), configuration(), 'operator');
    const report = testRepair(fleet, draft.id);
    expect(report.passed).toBe(0); expect(report.results[0].errors.join()).toContain('Conflicting event identity');
    expect(() => publishRepair(fleet, draft.id, 'operator', draft.revision)).toThrow('At least one');
  });
  it("redacts credentials in examples and rejects credential source paths", () => {
    const event = addEvent(payload({ password: 'not-for-the-browser' }));
    const incident = incidentFor(event.eventId);
    const context = repairContext(fleet, incident);
    expect(context.samples[0].payload.password).toBe('[REDACTED]');
    expect(context.paths.some(field => field.path === 'password')).toBe(false);
    const config = configuration(); config.rules[1].sources = ['password'];
    expect(() => saveRepair(fleet, incident, config, 'operator')).toThrow('source field');
  });
});

describe("OEM schema-change cases", () => {
  it("uses old-field fallbacks, retains zero values and omits removed optional measurements", () => {
    const config = configuration(); config.rules[1].sources.push("old_speed");
    const result = evaluateRepair(config, payload({ telemetry: { latitude: 0, longitude: 0 }, old_speed: "0" }), repairSignals());
    expect(result.success).toBe(true); expect(result.normalized.vehicle_speed).toBe(0);
    expect(result.normalized.battery_soc).toBeUndefined(); expect(result.warnings.join()).toContain("unknown");
  });
  it.each(["", "NaN", "Infinity", true, {}])("does not turn invalid numeric input %j into a measurement", value => {
    const result = evaluateRepair(configuration(), payload({ telemetry: { velocity: value } }), repairSignals()); expect(result.success).toBe(false);
  });
  it.each(["UNIX_SECONDS", "UNIX_MILLISECONDS"] as const)("converts %s to the original event time", conversion => {
    const config = configuration(); config.rules[0].conversion = conversion;
    const expected = "2026-10-01T10:00:00.000Z";
    const result = evaluateRepair(config, payload({ meta: { timestamp: Date.parse(expected) / (conversion === "UNIX_SECONDS" ? 1000 : 1) } }), repairSignals());
    expect(result.normalized.event_time).toBe(expected); expect(result.success).toBe(true);
  });
  it("rejects unknown enum codes and partially missing GPS pairs", () => {
    expect(evaluateRepair(configuration(), payload({ telemetry: { velocity: 10, ignition: "new-code" } }), repairSignals()).success).toBe(false);
    expect(evaluateRepair(configuration(), payload({ telemetry: { velocity: 10, latitude: 0 } }), repairSignals()).errors.join()).toContain("both latitude and longitude");
  });
  it("honours explicit version filters and maps indexed array values", () => {
    const config = configuration(); config.discriminator = { path: "meta.version", value: "r3" };
    expect(evaluateRepair(config, payload(), repairSignals()).success).toBe(false);
    delete config.discriminator; config.rules[1].sources = ["sensors.0.reading"];
    const result = evaluateRepair(config, payload({ sensors: [{ reading: 10 }] }), repairSignals());
    expect(result.normalized.vehicle_speed).toBeCloseTo(16.0934);
  });
});
