import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { ingestEvent } from "../services/ingestion.service.js";
import { drainWorker } from "../services/worker.service.js";
import { getDb } from "../db/pool.js";
import { v4 as uuid } from "uuid";

const TEST_DB_PATH = path.resolve("./data/zspeed_test_pipeline.db");
const FLEET_ID = "fleet_test_001";
const CONN_A = "test_conn_a";
const VEH_A1 = "test_veh_a1";
const VEH_A2 = "test_veh_a2";

function resetTestDb() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
}

function query(sql: string, params: any[] = []) {
  return getDb().prepare(sql).all(...params);
}

function queryOne(sql: string, params: any[] = []) {
  return getDb().prepare(sql).get(...params);
}

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params);
}

function setupTestFleet() {
  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [FLEET_ID, "Test Fleet"]);
  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_A, FLEET_ID, "oem_voltera", "Test Conn A", "ACTIVE"]);
  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [VEH_A1, FLEET_ID, "TESTVEH1", "NO_CONNECTION"]);
  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [VEH_A2, FLEET_ID, "TESTVEH2", "NO_CONNECTION"]);
  run("INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id) VALUES (?, ?, ?, ?)",
    [uuid(), VEH_A1, CONN_A, VEH_A1]);
}

function validVolteraV1Payload(lat = 51.5074, lon = -0.1278, ts?: string): any {
  return {
    timestamp: ts || new Date().toISOString(),
    speed_mph: 30,
    charge_fraction: 0.75,
    odo_miles: 10000,
    status: "running",
    lat,
    lon,
    altitude: 20,
    heading: 90,
    harsh_brake: false,
  };
}

describe("Ingestion pipeline integration", () => {
  beforeEach(() => {
    process.env.OVERRIDE_DB_PATH = TEST_DB_PATH;
    runMigrations();
    seedDatabase();
    setupTestFleet();
  });

  afterEach(() => {
    resetTestDb();
    delete process.env.OVERRIDE_DB_PATH;
  });

  it("processes a valid event and creates normalized_event", () => {
    const payload = validVolteraV1Payload();
    const result = ingestEvent(FLEET_ID, CONN_A, VEH_A1, payload, "evt001");
    expect(result.status).toBe("PROCESSED");

    const norm = query("SELECT * FROM normalized_events WHERE vehicle_id = ?", [VEH_A1]);
    expect(norm.length).toBeGreaterThan(0);
    const first = norm[0] as any;
    expect(first.latitude).not.toBeNull();
    expect(first.longitude).not.toBeNull();
    expect(first.event_time).not.toBeNull();
  });

  it("deduplicates exact same event", () => {
    const payload = validVolteraV1Payload();
    const r1 = ingestEvent(FLEET_ID, CONN_A, VEH_A1, payload, "evt_dup");
    const r2 = ingestEvent(FLEET_ID, CONN_A, VEH_A1, payload, "evt_dup");
    expect(r1.status).toBe("PROCESSED");
    expect(r2.status).toBe("DUPLICATE");
  });

  it("quarantines an unknown format event and creates quarantine record", () => {
    const payload = {
      telemetry_v3: { speed_kph: 50 },
      device_meta: { odometer_km: 20000 },
    };
    const result = ingestEvent(FLEET_ID, CONN_A, VEH_A1, payload, "evt_unknown_fmt");
    expect(result.status).toBe("QUARANTINED");

    const records = query("SELECT * FROM quarantine_records WHERE fleet_id = ?", [FLEET_ID]);
    expect(records.length).toBeGreaterThan(0);
    const rec = records[0] as any;
    expect(rec.failure_category).toBe("SCHEMA_CHANGE");
  });

  it("quarantines an out-of-range sensor value", () => {
    const payload = {
      timestamp: new Date().toISOString(),
      speed_mph: "sixty",
      charge_fraction: 0.5,
      odo_miles: 10000,
      status: "running",
    };
    const result = ingestEvent(FLEET_ID, CONN_A, VEH_A1, payload, "evt_bad_val");
    expect(result.status).toBe("QUARANTINED");

    const records = query(
      "SELECT * FROM quarantine_records WHERE fleet_id = ? AND failure_category = 'INVALID_VALUE'",
      [FLEET_ID]
    );
    expect(records.length).toBeGreaterThan(0);
  });

  it("creates quarantine incident grouping multiple quarantined events", () => {
    for (let i = 0; i < 3; i++) {
      const payload = { telemetry_v3: { speed_kph: 50 + i }, timestamp: new Date().toISOString() };
      ingestEvent(FLEET_ID, CONN_A, VEH_A1, payload, `evt_fmt_${i}`);
    }

    const incidents = query("SELECT * FROM quarantine_incidents WHERE fleet_id = ? AND status = 'UNRESOLVED'", [FLEET_ID]);
    expect(incidents.length).toBeGreaterThan(0);

    const incident = incidents[0] as any;
    expect(incident.unresolved_event_count).toBeGreaterThanOrEqual(3);
  });

  it("builds projections after processing events with GPS", () => {
    const t0 = new Date("2026-09-10T08:00:00Z");
    const waypoints = [
      { lat: 51.5074, lon: -0.1278 },
      { lat: 51.5100, lon: -0.1230 },
      { lat: 51.5130, lon: -0.1180 },
      { lat: 51.5180, lon: -0.1130 },
      { lat: 51.5210, lon: -0.1100 },
    ];

    for (let i = 0; i < waypoints.length; i++) {
      const t = new Date(t0.getTime() + i * 60000);
      const payload = validVolteraV1Payload(waypoints[i].lat, waypoints[i].lon, t.toISOString());
      payload.status = i < waypoints.length - 1 ? "running" : "stopped";
      ingestEvent(FLEET_ID, CONN_A, VEH_A1, payload, `gps_evt_${i}`);
    }

    drainWorker();

    const trips = query("SELECT * FROM trips WHERE vehicle_id = ?", [VEH_A1]);
    expect(trips.length).toBeGreaterThan(0);
  });
});

describe("Replay integration", () => {
  beforeEach(() => {
    process.env.OVERRIDE_DB_PATH = TEST_DB_PATH;
    runMigrations();
    seedDatabase();
    setupTestFleet();
  });

  afterEach(() => {
    resetTestDb();
    delete process.env.OVERRIDE_DB_PATH;
  });

  it("repeated replay does not double-count trips", () => {
    const t0 = new Date("2026-09-10T08:00:00Z");

    run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
      [VEH_A2, FLEET_ID, "TESTVEH2", "NO_CONNECTION"]);
    run("INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id) VALUES (?, ?, ?, ?)",
      [uuid(), VEH_A2, CONN_A, VEH_A2]);

    for (let i = 0; i < 5; i++) {
      const t = new Date(t0.getTime() + i * 60000);
      const p = validVolteraV1Payload(51.5074 + i * 0.001, -0.1278, t.toISOString());
      p.status = i < 4 ? "running" : "stopped";
      ingestEvent(FLEET_ID, CONN_A, VEH_A1, p, `evt_r_${i}`);
    }
    drainWorker();

    const tripCount1 = (queryOne("SELECT COUNT(*) as c FROM trips WHERE vehicle_id = ? AND projection_status = 'CURRENT'", [VEH_A1]) as any)?.c || 0;

    drainWorker();

    const tripCount2 = (queryOne("SELECT COUNT(*) as c FROM trips WHERE vehicle_id = ? AND projection_status = 'CURRENT'", [VEH_A1]) as any)?.c || 0;

    expect(tripCount2).toBe(tripCount1);
  });
});
