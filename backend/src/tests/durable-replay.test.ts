import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import type { Server } from "http";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { getDb, closeDb } from "../db/pool.js";
import { app } from "../index.js";
import {
  ingestEvent,
  replayEvents,
  runReplayJob,
} from "../services/ingestion.service.js";
import {
  drainWorker,
  recoverAbandonedJobs,
} from "../services/worker.service.js";
import { v4 as uuid } from "uuid";

const FLEET_1 = "fleet_rep_01";
const FLEET_2 = "fleet_rep_02";

const CONN_F1_VLT = "conn_f1_voltera";
const CONN_F1_CRS = "conn_f1_crestline";
const CONN_F2_VLT = "conn_f2_voltera";
const CONN_F2_CRS = "conn_f2_crestline";

const VEH_F1_VLT = "veh_f1_vlt";
const VEH_F1_CRS = "veh_f1_crs";
const VEH_F2_VLT = "veh_f2_vlt";
const VEH_F2_CRS = "veh_f2_crs";

let testDbPath: string;
let server: Server;
let baseUrl: string;

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params);
}

function queryOne<T = any>(sql: string, params: any[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T;
}

function query<T = any>(sql: string, params: any[] = []): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

function setupTwoFleetsTwoOems() {
  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [FLEET_1, "Fleet One"]);
  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [FLEET_2, "Fleet Two"]);

  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_F1_VLT, FLEET_1, "oem_voltera", "F1 Voltera", "ACTIVE"]);
  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_F1_CRS, FLEET_1, "oem_crestline", "F1 Crestline", "ACTIVE"]);
  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_F2_VLT, FLEET_2, "oem_voltera", "F2 Voltera", "ACTIVE"]);
  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_F2_CRS, FLEET_2, "oem_crestline", "F2 Crestline", "ACTIVE"]);

  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [VEH_F1_VLT, FLEET_1, "1VF1VOLT000000001", "NO_CONNECTION"]);
  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [VEH_F1_CRS, FLEET_1, "1VF1CRES000000001", "NO_CONNECTION"]);
  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [VEH_F2_VLT, FLEET_2, "1VF2VOLT000000002", "NO_CONNECTION"]);
  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [VEH_F2_CRS, FLEET_2, "1VF2CRES000000002", "NO_CONNECTION"]);

  run("INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES (?, ?, ?, ?, ?)",
    [uuid(), VEH_F1_VLT, CONN_F1_VLT, "VLT-F1-01", 1]);
  run("INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES (?, ?, ?, ?, ?)",
    [uuid(), VEH_F1_CRS, CONN_F1_CRS, "CRS-F1-01", 1]);
  run("INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES (?, ?, ?, ?, ?)",
    [uuid(), VEH_F2_VLT, CONN_F2_VLT, "VLT-F2-01", 1]);
  run("INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES (?, ?, ?, ?, ?)",
    [uuid(), VEH_F2_CRS, CONN_F2_CRS, "CRS-F2-01", 1]);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  testDbPath = path.join(os.tmpdir(), `zspeed_test_rep_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  process.env.OVERRIDE_DB_PATH = testDbPath;
  closeDb();
  runMigrations();
  seedDatabase();
  setupTwoFleetsTwoOems();
});

afterEach(() => {
  closeDb();
  try { fs.unlinkSync(testDbPath); } catch {}
  try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
  try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  delete process.env.OVERRIDE_DB_PATH;
});

describe("Durable Scoped Replay and Quarantine Resolution", () => {
  it("replays only intended events across two OEMs and two fleets with mixed incidents", async () => {
    const unmappedVolteraPayload1 = {
      velocity_v2: 55,
      battery_v2: 0.82,
      lat: 51.5074,
      lon: -0.1278,
      timestamp: "2026-09-30T10:00:00Z",
    };
    const unmappedVolteraPayload2 = {
      velocity_v2: 60,
      battery_v2: 0.80,
      lat: 51.5100,
      lon: -0.1250,
      timestamp: "2026-09-30T10:05:00Z",
    };
    const unmappedCrestlinePayload = {
      state: {
        unknown_speed: 70,
        gps_lat: 48.8566,
        gps_lon: 2.3522,
      },
      time_measured: 1727690400000,
    };

    ingestEvent(FLEET_1, CONN_F1_VLT, "VLT-F1-01", unmappedVolteraPayload1, "f1_vlt_1");
    ingestEvent(FLEET_1, CONN_F1_VLT, "VLT-F1-01", unmappedVolteraPayload2, "f1_vlt_2");

    ingestEvent(FLEET_1, CONN_F1_CRS, "CRS-F1-01", unmappedCrestlinePayload, "f1_crs_1");

    ingestEvent(FLEET_2, CONN_F2_VLT, "VLT-F2-01", unmappedVolteraPayload1, "f2_vlt_1");

    ingestEvent(FLEET_2, CONN_F2_CRS, "CRS-F2-01", unmappedCrestlinePayload, "f2_crs_1");

    const totalQuarantinedBefore = queryOne<any>(
      "SELECT COUNT(*) as count FROM raw_events WHERE processing_status = 'QUARANTINED'"
    ).count;
    expect(totalQuarantinedBefore).toBe(5);

    const f1VltIncident = queryOne<any>(
      "SELECT * FROM quarantine_incidents WHERE fleet_id = ? AND connection_id = ? AND status = 'UNRESOLVED'",
      [FLEET_1, CONN_F1_VLT]
    );
    expect(f1VltIncident).toBeDefined();

    const fmtId = "fmt_voltera_v2_custom";
    run(
      `INSERT INTO oem_format_versions (id, oem_id, event_type, format_version, expected_structure) VALUES (?, ?, ?, ?, ?)`,
      [fmtId, "oem_voltera", "telemetry", "v2_custom", JSON.stringify({
        velocity_v2: "number",
        battery_v2: "number",
        lat: "number",
        lon: "number",
        timestamp: "string",
      })]
    );

    const profileId = "prof_voltera_v2_pub";
    run(
      `INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status)
       VALUES (?, ?, '1.0', '1.0', 'ACTIVE')`,
      [profileId, fmtId]
    );

    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "velocity_v2", "sig_speed", "MPH_TO_KMH"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "battery_v2", "sig_soc", "FRACTION_TO_PERCENT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "lat", "sig_latitude", "DIRECT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "lon", "sig_longitude", "DIRECT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "timestamp", "sig_event_time", "DIRECT"]
    );

    const retryRes = await fetch(`${baseUrl}/api/quarantine/incidents/${f1VltIncident.id}/retry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_1}:fleet_manager`,
      },
      body: JSON.stringify({ mapping_profile_id: profileId }),
    });

    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json() as any;
    expect(retryBody.success).toBe(true);

    drainWorker();

    const replayJob = queryOne<any>("SELECT * FROM replay_jobs WHERE id = ?", [retryBody.jobId]);
    expect(replayJob.status).toBe("COMPLETED");
    expect(replayJob.processed_events).toBe(2);
    expect(replayJob.error_events).toBe(0);

    const f1VltRaw = query<any>("SELECT * FROM raw_events WHERE fleet_id = ? AND connection_id = ?", [FLEET_1, CONN_F1_VLT]);
    expect(f1VltRaw.every((e) => e.processing_status === "PROCESSED")).toBe(true);

    const f1CrsRaw = query<any>("SELECT * FROM raw_events WHERE fleet_id = ? AND connection_id = ?", [FLEET_1, CONN_F1_CRS]);
    expect(f1CrsRaw.every((e) => e.processing_status === "QUARANTINED")).toBe(true);

    const f2VltRaw = query<any>("SELECT * FROM raw_events WHERE fleet_id = ? AND connection_id = ?", [FLEET_2, CONN_F2_VLT]);
    expect(f2VltRaw.every((e) => e.processing_status === "QUARANTINED")).toBe(true);

    const f2CrsRaw = query<any>("SELECT * FROM raw_events WHERE fleet_id = ? AND connection_id = ?", [FLEET_2, CONN_F2_CRS]);
    expect(f2CrsRaw.every((e) => e.processing_status === "QUARANTINED")).toBe(true);

    const f1VltIncidentAfter = queryOne<any>("SELECT * FROM quarantine_incidents WHERE id = ?", [f1VltIncident.id]);
    expect(f1VltIncidentAfter.status).toBe("RESOLVED");

    const f1Norm = query<any>("SELECT * FROM normalized_events WHERE vehicle_id = ?", [VEH_F1_VLT]);
    expect(f1Norm.length).toBe(2);

    const f2Norm = query<any>("SELECT * FROM normalized_events WHERE vehicle_id = ?", [VEH_F2_VLT]);
    expect(f2Norm.length).toBe(0);
  });

  it("handles process restart mid-replay without duplicating normalized events or trips", () => {
    const p1 = { velocity_v2: 50, battery_v2: 0.9, lat: 51.5074, lon: -0.1278, timestamp: "2026-09-30T11:00:00Z" };
    const p2 = { velocity_v2: 52, battery_v2: 0.89, lat: 51.5100, lon: -0.1250, timestamp: "2026-09-30T11:05:00Z" };

    const raw1 = ingestEvent(FLEET_1, CONN_F1_VLT, "VLT-F1-01", p1, "evt_mid_1");
    const raw2 = ingestEvent(FLEET_1, CONN_F1_VLT, "VLT-F1-01", p2, "evt_mid_2");

    const fmtId = "fmt_voltera_mid";
    run(
      `INSERT INTO oem_format_versions (id, oem_id, event_type, format_version, expected_structure) VALUES (?, ?, ?, ?, ?)`,
      [fmtId, "oem_voltera", "telemetry", "v_mid", JSON.stringify({
        velocity_v2: "number",
        battery_v2: "number",
        lat: "number",
        lon: "number",
        timestamp: "string",
      })]
    );

    const profileId = "prof_voltera_mid";
    run(
      `INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status)
       VALUES (?, ?, '1.0', '1.0', 'ACTIVE')`,
      [profileId, fmtId]
    );

    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "velocity_v2", "sig_speed", "MPH_TO_KMH"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "battery_v2", "sig_soc", "FRACTION_TO_PERCENT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "lat", "sig_latitude", "DIRECT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "lon", "sig_longitude", "DIRECT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "timestamp", "sig_event_time", "DIRECT"]
    );

    run("UPDATE raw_events SET processing_status = 'PROCESSED' WHERE id = ?", [raw1.eventId]);
    run(
      `INSERT INTO normalized_events (id, raw_event_id, vehicle_id, mapping_profile_id, canonical_schema_version, canonical_values, quality_flags, event_time, latitude, longitude)
       VALUES (?, ?, ?, ?, '1.0', '{}', '[]', '2026-09-30T11:00:00Z', 51.5074, -0.1278)`,
      [uuid(), raw1.eventId, VEH_F1_VLT, profileId]
    );

    const replayRes = replayEvents(profileId, { fleet_id: FLEET_1, connection_id: CONN_F1_VLT });
    const queueJob = queryOne<any>("SELECT * FROM job_queue WHERE job_type = 'REPLAY_JOB' AND status = 'PENDING'");

    run(
      `UPDATE job_queue SET status = 'RUNNING', started_at = datetime('now', '-50 seconds'), worker_id = 'crashed_wkr' WHERE id = ?`,
      [queueJob.id]
    );

    recoverAbandonedJobs(30);

    const recoveredJob = queryOne<any>("SELECT * FROM job_queue WHERE id = ?", [queueJob.id]);
    expect(recoveredJob.status).toBe("PENDING");

    drainWorker();

    const replayJob = queryOne<any>("SELECT * FROM replay_jobs WHERE id = ?", [replayRes.jobId]);
    expect(replayJob.status).toBe("COMPLETED");

    const normCount = queryOne<any>("SELECT COUNT(*) as count FROM normalized_events WHERE vehicle_id = ?", [VEH_F1_VLT]).count;
    expect(normCount).toBe(2);

    const tripCount = queryOne<any>("SELECT COUNT(*) as count FROM trips WHERE vehicle_id = ?", [VEH_F1_VLT]).count;
    expect(tripCount).toBeLessThanOrEqual(2);
  });

  it("repeated replay execution is strictly idempotent", () => {
    const p1 = { velocity_rep: 45, battery_rep: 0.95, lat: 51.5074, lon: -0.1278, timestamp: "2026-09-30T12:00:00Z" };
    ingestEvent(FLEET_1, CONN_F1_VLT, "VLT-F1-01", p1, "evt_rep_idemp");

    const fmtId = "fmt_voltera_idemp";
    run(
      `INSERT INTO oem_format_versions (id, oem_id, event_type, format_version, expected_structure) VALUES (?, ?, ?, ?, ?)`,
      [fmtId, "oem_voltera", "telemetry", "v_idemp", JSON.stringify({
        velocity_rep: "number",
        battery_rep: "number",
        lat: "number",
        lon: "number",
        timestamp: "string",
      })]
    );

    const profileId = "prof_voltera_idemp";
    run(
      `INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status)
       VALUES (?, ?, '1.0', '1.0', 'ACTIVE')`,
      [profileId, fmtId]
    );

    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "velocity_rep", "sig_speed", "MPH_TO_KMH"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "battery_rep", "sig_soc", "FRACTION_TO_PERCENT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "lat", "sig_latitude", "DIRECT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "lon", "sig_longitude", "DIRECT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "timestamp", "sig_event_time", "DIRECT"]
    );

    const r1 = replayEvents(profileId, { fleet_id: FLEET_1, connection_id: CONN_F1_VLT });
    drainWorker();

    const normCount1 = queryOne<any>("SELECT COUNT(*) as count FROM normalized_events WHERE vehicle_id = ?", [VEH_F1_VLT]).count;
    expect(normCount1).toBe(1);

    const r2 = replayEvents(profileId, { fleet_id: FLEET_1, connection_id: CONN_F1_VLT });
    drainWorker();

    const normCount2 = queryOne<any>("SELECT COUNT(*) as count FROM normalized_events WHERE vehicle_id = ?", [VEH_F1_VLT]).count;
    expect(normCount2).toBe(1);
  });

  it("handles partial failure during replay, leaves failed records open and marks outcome PARTIAL_SUCCESS", () => {
    const validPayload = { velocity_part: 45, lat: 51.5074, lon: -0.1278, timestamp: "2026-09-30T13:00:00Z" };
    const invalidCoordsPayload = { velocity_part: 45, lat: 195.0, lon: -0.1278, timestamp: "2026-09-30T13:05:00Z" };

    const res1 = ingestEvent(FLEET_1, CONN_F1_VLT, "VLT-F1-01", validPayload, "evt_part_good");
    const res2 = ingestEvent(FLEET_1, CONN_F1_VLT, "VLT-F1-01", invalidCoordsPayload, "evt_part_bad");

    const fmtId = "fmt_voltera_part";
    run(
      `INSERT INTO oem_format_versions (id, oem_id, event_type, format_version, expected_structure) VALUES (?, ?, ?, ?, ?)`,
      [fmtId, "oem_voltera", "telemetry", "v_part", JSON.stringify({
        velocity_part: "number",
        lat: "number",
        lon: "number",
        timestamp: "string",
      })]
    );

    const profileId = "prof_voltera_part";
    run(
      `INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status)
       VALUES (?, ?, '1.0', '1.0', 'ACTIVE')`,
      [profileId, fmtId]
    );

    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "velocity_part", "sig_speed", "MPH_TO_KMH"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "lat", "sig_latitude", "DIRECT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "lon", "sig_longitude", "DIRECT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), profileId, "timestamp", "sig_event_time", "DIRECT"]
    );

    const r = replayEvents(profileId, { fleet_id: FLEET_1, connection_id: CONN_F1_VLT });
    drainWorker();

    const replayJob = queryOne<any>("SELECT * FROM replay_jobs WHERE id = ?", [r.jobId]);
    expect(replayJob.status).toBe("COMPLETED");
    expect(replayJob.final_outcome).toBe("PARTIAL_SUCCESS");
    expect(replayJob.processed_events).toBe(1);
    expect(replayJob.error_events).toBe(1);

    const recGood = queryOne<any>("SELECT * FROM quarantine_records WHERE raw_event_id = ?", [res1.eventId]);
    expect(recGood.status).toBe("RESOLVED");

    const recBad = queryOne<any>("SELECT * FROM quarantine_records WHERE raw_event_id = ?", [res2.eventId]);
    expect(recBad.status).toBe("REPLAY_FAILED");
    expect(recBad.failure_detail).toContain("latitude");

    const attempts = query<any>("SELECT * FROM normalization_attempts WHERE raw_event_id = ? ORDER BY attempted_at DESC", [res2.eventId]);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0].status).toBe("FAILED");
  });

  it("fleet manager can safely retry an incident but cannot publish mappings", async () => {
    const resPublish = await fetch(`${baseUrl}/api/ingestion/mappings/some-id/publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer demo:${FLEET_1}:fleet_manager`,
      },
    });
    expect(resPublish.status).toBe(403);

    const incidentId = uuid();
    run(
      `INSERT INTO quarantine_incidents (id, fleet_id, oem_id, connection_id, title, failure_category, first_failure_at, latest_at, status)
       VALUES (?, ?, 'oem_voltera', ?, 'Test Incident', 'SCHEMA_CHANGE', datetime('now'), datetime('now'), 'UNRESOLVED')`,
      [incidentId, FLEET_1, CONN_F1_VLT]
    );

    const resCrossTenantRetry = await fetch(`${baseUrl}/api/quarantine/incidents/${incidentId}/retry`, {
      method: "POST",
      headers: {
        Authorization: `Bearer demo:${FLEET_2}:fleet_manager`,
      },
    });
    expect(resCrossTenantRetry.status).toBe(404);

    const resSafeRetry = await fetch(`${baseUrl}/api/quarantine/incidents/${incidentId}/retry`, {
      method: "POST",
      headers: {
        Authorization: `Bearer demo:${FLEET_1}:fleet_manager`,
      },
    });
    expect(resSafeRetry.status).toBe(200);
    const retryBody = await resSafeRetry.json() as any;
    expect(retryBody.success).toBe(true);
    expect(retryBody.jobId).toBeDefined();
  });
});
