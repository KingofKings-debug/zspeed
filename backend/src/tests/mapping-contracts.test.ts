import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { getDb, closeDb } from "../db/pool.js";
import {
  ingestEvent,
  processRawEvent,
  previewMapping,
  replayEvents,
  runReplayJob,
} from "../services/ingestion.service.js";
import { v4 as uuid } from "uuid";

const FLEET_ID = "fleet_mapping_test";
const CONN_ID = "conn_mapping_voltera";
const VEH_ID = "veh_mapping_001";
const OEM_VEH_ID = "VLT-M-001";

let testDbPath: string;

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params);
}

function queryOne<T = any>(sql: string, params: any[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T;
}

function query<T = any>(sql: string, params: any[] = []): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

function setupMappingFleet() {
  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [FLEET_ID, "Mapping Test Fleet"]);
  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_ID, FLEET_ID, "oem_voltera", "Mapping Conn", "ACTIVE"]);
  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [VEH_ID, FLEET_ID, "1VXMATESTVIN00001", "NO_CONNECTION"]);
  run("INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES (?, ?, ?, ?, ?)",
    [uuid(), VEH_ID, CONN_ID, OEM_VEH_ID, 1]);
}

beforeEach(() => {
  testDbPath = path.join(os.tmpdir(), `zspeed_test_mapping_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  process.env.OVERRIDE_DB_PATH = testDbPath;
  closeDb();
  runMigrations();
  seedDatabase();
  setupMappingFleet();
});

afterEach(() => {
  closeDb();
  try { fs.unlinkSync(testDbPath); } catch {}
  try { fs.unlinkSync(`${testDbPath}-wal`); } catch {}
  try { fs.unlinkSync(`${testDbPath}-shm`); } catch {}
});

describe("Versioned OEM Format Contracts and Safe Mapping Workflow", () => {
  it("successfully validates and normalizes valid v1 and v2 payloads with recorded versions", () => {
    const v1Payload = {
      timestamp: "2026-09-30T10:00:00Z",
      speed_mph: 45,
      charge_fraction: 0.85,
      odo_miles: 15400,
      status: "running",
      lat: 51.5074,
      lon: -0.1278,
      altitude: 25,
      heading: 180,
      harsh_brake: false,
    };

    const resV1 = ingestEvent(FLEET_ID, CONN_ID, OEM_VEH_ID, v1Payload, "evt_v1_001");
    expect(resV1.status).toBe("PROCESSED");

    const normV1 = queryOne<any>(
      "SELECT * FROM normalized_events WHERE raw_event_id = ?",
      [resV1.eventId]
    );
    expect(normV1).toBeDefined();
    expect(normV1.canonical_schema_version).toBe("1.0");
    const v1Values = JSON.parse(normV1.canonical_values);
    expect(v1Values.vehicle_speed).toBeCloseTo(45 * 1.60934, 1);
    expect(v1Values.battery_soc).toBe(85);

    const v2Payload = {
      data: {
        speed_mph: 55,
        charge_fraction: 0.70,
        lat: 51.5150,
        lon: -0.1350,
      },
      metadata: {
        timestamp: "2026-09-30T10:05:00Z",
        odo_miles: 15405,
        status: "running",
      },
    };

    const resV2 = ingestEvent(FLEET_ID, CONN_ID, OEM_VEH_ID, v2Payload, "evt_v2_001");
    expect(resV2.status).toBe("PROCESSED");

    const normV2 = queryOne<any>(
      "SELECT * FROM normalized_events WHERE raw_event_id = ?",
      [resV2.eventId]
    );
    expect(normV2).toBeDefined();
    expect(normV2.canonical_schema_version).toBe("1.0");
    const v2Values = JSON.parse(normV2.canonical_values);
    expect(v2Values.vehicle_speed).toBeCloseTo(55 * 1.60934, 1);
    expect(v2Values.battery_soc).toBe(70);
  });

  it("quarantines payload with a renamed required field without silently skipping or guessing", () => {
    const renamedPayload = {
      timestamp: "2026-09-30T10:00:00Z",
      vehicle_speed: 45,
      charge_fraction: 0.85,
      odo_miles: 15400,
      status: "running",
      lat: 51.5074,
      lon: -0.1278,
    };

    const res = ingestEvent(FLEET_ID, CONN_ID, OEM_VEH_ID, renamedPayload, "evt_renamed_001");
    expect(res.status).toBe("QUARANTINED");

    const normCount = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM normalized_events WHERE raw_event_id = ?",
      [res.eventId]
    );
    expect(normCount?.count).toBe(0);

    const quarantineRecord = queryOne<any>(
      "SELECT * FROM quarantine_records WHERE raw_event_id = ?",
      [res.eventId]
    );
    expect(quarantineRecord).toBeDefined();
    expect(quarantineRecord.failure_category).toBe("SCHEMA_CHANGE");

    const incident = queryOne<any>(
      "SELECT * FROM quarantine_incidents WHERE fleet_id = ? AND status = 'UNRESOLVED'",
      [FLEET_ID]
    );
    expect(incident).toBeDefined();
  });

  it("accepts an extra optional field and normalizes successfully", () => {
    const extraFieldPayload = {
      timestamp: "2026-09-30T10:00:00Z",
      speed_mph: 30,
      charge_fraction: 0.9,
      odo_miles: 5000,
      status: "running",
      lat: 51.5074,
      lon: -0.1278,
      ambient_temperature_c: 21.5,
      firmware_version: "v4.2.1",
    };

    const res = ingestEvent(FLEET_ID, CONN_ID, OEM_VEH_ID, extraFieldPayload, "evt_extra_001");
    expect(res.status).toBe("PROCESSED");

    const norm = queryOne<any>(
      "SELECT * FROM normalized_events WHERE raw_event_id = ?",
      [res.eventId]
    );
    expect(norm).toBeDefined();
    const values = JSON.parse(norm.canonical_values);
    expect(values.vehicle_speed).toBeCloseTo(30 * 1.60934, 1);
  });

  it("quarantines payload with invalid units or types", () => {
    const invalidTypePayload = {
      timestamp: "2026-09-30T10:00:00Z",
      speed_mph: "eighty_mph",
      charge_fraction: 0.8,
      lat: 51.5074,
      lon: -0.1278,
    };

    const res = ingestEvent(FLEET_ID, CONN_ID, OEM_VEH_ID, invalidTypePayload, "evt_invalid_type_001");
    expect(res.status).toBe("QUARANTINED");

    const record = queryOne<any>(
      "SELECT * FROM quarantine_records WHERE raw_event_id = ?",
      [res.eventId]
    );
    expect(record).toBeDefined();
    expect(record.failure_category).toMatch(/TYPE_ERROR|INVALID_VALUE/);
  });

  it("quarantines payload with invalid GPS coordinates or invalid timestamp", () => {
    const invalidGpsPayload = {
      timestamp: "2026-09-30T10:00:00Z",
      speed_mph: 30,
      charge_fraction: 0.8,
      lat: 125.0,
      lon: -0.1278,
    };

    const resGps = ingestEvent(FLEET_ID, CONN_ID, OEM_VEH_ID, invalidGpsPayload, "evt_bad_gps_001");
    expect(resGps.status).toBe("QUARANTINED");

    const recordGps = queryOne<any>(
      "SELECT * FROM quarantine_records WHERE raw_event_id = ?",
      [resGps.eventId]
    );
    expect(recordGps.failure_category).toBe("INVALID_COORDINATES");

    const invalidTimePayload = {
      timestamp: "definitely_not_a_valid_date",
      speed_mph: 30,
      charge_fraction: 0.8,
      lat: 51.5074,
      lon: -0.1278,
    };

    const resTime = ingestEvent(FLEET_ID, CONN_ID, OEM_VEH_ID, invalidTimePayload, "evt_bad_time_001");
    expect(resTime.status).toBe("QUARANTINED");

    const recordTime = queryOne<any>(
      "SELECT * FROM quarantine_records WHERE raw_event_id = ?",
      [resTime.eventId]
    );
    expect(recordTime.failure_category).toBe("INVALID_TIME");
  });

  it("executes safe mapping workflow: preview, publish immutable profile, replay to resolve incident", () => {
    const customPayload = {
      timestamp: "2026-09-30T12:00:00Z",
      velocity_mph: 50,
      battery_level: 0.88,
      lat: 51.5074,
      lon: -0.1278,
    };

    const initialRes = ingestEvent(FLEET_ID, CONN_ID, OEM_VEH_ID, customPayload, "evt_custom_001");
    expect(initialRes.status).toBe("QUARANTINED");

    const incident = queryOne<any>(
      "SELECT * FROM quarantine_incidents WHERE fleet_id = ? AND status = 'UNRESOLVED'",
      [FLEET_ID]
    );
    expect(incident).toBeDefined();

    const newFormatId = "fmt_voltera_telemetry_v3";
    run(
      `INSERT INTO oem_format_versions (id, oem_id, event_type, format_version, expected_structure) VALUES (?, ?, ?, ?, ?)`,
      [newFormatId, "oem_voltera", "telemetry", "v3", JSON.stringify({
        velocity_mph: "number",
        battery_level: "number",
        lat: "number",
        lon: "number",
        timestamp: "string",
      })]
    );

    const newProfileId = "prof_voltera_v3_draft";
    run(
      `INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status) VALUES (?, ?, ?, ?, 'DRAFT')`,
      [newProfileId, newFormatId, "1.0", "1.0"]
    );

    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), newProfileId, "velocity_mph", "sig_speed", "MPH_TO_KMH"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), newProfileId, "battery_level", "sig_soc", "FRACTION_TO_PERCENT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), newProfileId, "lat", "sig_latitude", "DIRECT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), newProfileId, "lon", "sig_longitude", "DIRECT"]
    );
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), newProfileId, "timestamp", "sig_event_time", "DIRECT"]
    );

    const preview = previewMapping(newProfileId, customPayload);
    expect(preview.success).toBe(true);
    expect(preview.normalized?.vehicle_speed).toBeCloseTo(50 * 1.60934, 1);
    expect(preview.normalized?.battery_soc).toBe(88);

    run("UPDATE mapping_profiles SET status = 'ACTIVE' WHERE id = ?", [newProfileId]);

    const replay = replayEvents(newProfileId, { fleet_id: FLEET_ID, connection_id: CONN_ID });
    expect(replay.jobId).toBeDefined();

    runReplayJob(replay.jobId, newProfileId);

    const replayJob = queryOne<any>("SELECT * FROM replay_jobs WHERE id = ?", [replay.jobId]);
    expect(replayJob.status).toBe("COMPLETED");
    expect(replayJob.processed_events).toBeGreaterThan(0);

    const norm = queryOne<any>(
      "SELECT * FROM normalized_events WHERE raw_event_id = ?",
      [initialRes.eventId]
    );
    expect(norm).toBeDefined();
    expect(norm.canonical_schema_version).toBe("1.0");

    const updatedRecord = queryOne<any>(
      "SELECT * FROM quarantine_records WHERE raw_event_id = ?",
      [initialRes.eventId]
    );
    expect(updatedRecord?.status).toBe("RESOLVED");
  });
});
