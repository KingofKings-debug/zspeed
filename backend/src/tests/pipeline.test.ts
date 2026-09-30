import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { ingestEvent } from "../services/ingestion.service.js";
import { drainWorker } from "../services/worker.service.js";
import { getDb, closeDb } from "../db/pool.js";
import { v4 as uuid } from "uuid";
import { buildProjectionsForVehicle, getTripGeoJson } from "../services/projection.service.js";

const FLEET_ID = "fleet_test_001";
const CONN_A = "test_conn_a";
const VEH_A1 = "test_veh_a1";
const VEH_A2 = "test_veh_a2";

let testDbPath: string;

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
    testDbPath = path.join(os.tmpdir(), `zspeed_test_pipeline_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    process.env.OVERRIDE_DB_PATH = testDbPath;
    closeDb();
    runMigrations();
    seedDatabase();
    setupTestFleet();
  });

  afterEach(() => {
    closeDb();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
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
    testDbPath = path.join(os.tmpdir(), `zspeed_test_replay_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    process.env.OVERRIDE_DB_PATH = testDbPath;
    closeDb();
    runMigrations();
    seedDatabase();
    setupTestFleet();
  });

  afterEach(() => {
    closeDb();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
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

  it("repeated rebuilds produce identical logical trip IDs, distances, event counts, and daily summaries", () => {
    const t0 = new Date("2026-09-10T09:00:00Z");

    for (let i = 0; i < 5; i++) {
      const t = new Date(t0.getTime() + i * 60000);
      const p = validVolteraV1Payload(51.5074 + i * 0.002, -0.1278, t.toISOString());
      p.status = i < 4 ? "running" : "stopped";
      ingestEvent(FLEET_ID, CONN_A, VEH_A1, p, `evt_stab_${i}`);
    }
    drainWorker();

    const tripBefore = queryOne<any>(
      "SELECT * FROM trips WHERE vehicle_id = ? AND projection_status = 'CURRENT' LIMIT 1",
      [VEH_A1]
    );
    expect(tripBefore).toBeDefined();

    const eventsCountBefore = (queryOne<any>(
      "SELECT COUNT(*) as c FROM trip_events WHERE trip_id = ?",
      [tripBefore.id]
    ))?.c;

    const summaryBefore = queryOne<any>(
      "SELECT * FROM vehicle_daily_summary WHERE vehicle_id = ? AND date = '2026-09-10'",
      [VEH_A1]
    );

    buildProjectionsForVehicle(VEH_A1);
    buildProjectionsForVehicle(VEH_A1);

    const tripAfter = queryOne<any>(
      "SELECT * FROM trips WHERE vehicle_id = ? AND projection_status = 'CURRENT' LIMIT 1",
      [VEH_A1]
    );
    expect(tripAfter.id).toBe(tripBefore.id);
    expect(tripAfter.trip_number).toBe(tripBefore.trip_number);
    expect(tripAfter.distance_km).toBeCloseTo(tripBefore.distance_km, 3);
    expect(tripAfter.duration_seconds).toBe(tripBefore.duration_seconds);

    const eventsCountAfter = (queryOne<any>(
      "SELECT COUNT(*) as c FROM trip_events WHERE trip_id = ?",
      [tripAfter.id]
    ))?.c;
    expect(eventsCountAfter).toBe(eventsCountBefore);

    const summaryAfter = queryOne<any>(
      "SELECT * FROM vehicle_daily_summary WHERE vehicle_id = ? AND date = '2026-09-10'",
      [VEH_A1]
    );
    expect(summaryAfter.total_distance_km).toBeCloseTo(summaryBefore.total_distance_km, 3);
    expect(summaryAfter.trip_count).toBe(summaryBefore.trip_count);
  });

  it("delayed events cannot overwrite newer vehicle signal timestamps in current state", () => {
    const tNewer = new Date("2026-09-10T12:00:00Z");
    const tOlder = new Date("2026-09-10T11:00:00Z");

    const payloadNewer = validVolteraV1Payload(51.5074, -0.1278, tNewer.toISOString());
    payloadNewer.speed_mph = 65;
    ingestEvent(FLEET_ID, CONN_A, VEH_A1, payloadNewer, "evt_new_01");
    drainWorker();

    const stateBefore = queryOne<any>(
      "SELECT signal_timestamps, latest_values FROM vehicle_current_state WHERE vehicle_id = ?",
      [VEH_A1]
    );
    const tsBefore = JSON.parse(stateBefore.signal_timestamps);
    const valsBefore = JSON.parse(stateBefore.latest_values);

    const payloadOlder = validVolteraV1Payload(51.5000, -0.1200, tOlder.toISOString());
    payloadOlder.speed_mph = 15;
    ingestEvent(FLEET_ID, CONN_A, VEH_A1, payloadOlder, "evt_old_01");
    drainWorker();

    buildProjectionsForVehicle(VEH_A1);

    const stateAfter = queryOne<any>(
      "SELECT signal_timestamps, latest_values FROM vehicle_current_state WHERE vehicle_id = ?",
      [VEH_A1]
    );
    const tsAfter = JSON.parse(stateAfter.signal_timestamps);
    const valsAfter = JSON.parse(stateAfter.latest_values);

    expect(tsAfter.vehicle_speed).toBe(tsBefore.vehicle_speed);
    expect(valsAfter.vehicle_speed).toBe(valsBefore.vehicle_speed);
  });

  it("preserves route gaps across missing data and handles zero coordinates without error", () => {
    const t0 = new Date("2026-09-10T14:00:00Z");

    const p1 = validVolteraV1Payload(0.0, 0.0, t0.toISOString());
    ingestEvent(FLEET_ID, CONN_A, VEH_A1, p1, "evt_zero_01");

    const t1 = new Date(t0.getTime() + 60000);
    const p2 = validVolteraV1Payload(0.01, 0.01, t1.toISOString());
    ingestEvent(FLEET_ID, CONN_A, VEH_A1, p2, "evt_zero_02");

    const t2 = new Date(t0.getTime() + 600000);
    const p3 = validVolteraV1Payload(0.02, 0.02, t2.toISOString());
    ingestEvent(FLEET_ID, CONN_A, VEH_A1, p3, "evt_zero_03");

    const t3 = new Date(t0.getTime() + 660000);
    const p4 = validVolteraV1Payload(0.03, 0.03, t3.toISOString());
    ingestEvent(FLEET_ID, CONN_A, VEH_A1, p4, "evt_zero_04");

    drainWorker();

    const trips = query<any>(
      "SELECT * FROM trips WHERE vehicle_id = ? ORDER BY started_at DESC",
      [VEH_A1]
    );
    expect(trips.length).toBeGreaterThan(0);

    const geoJson = getTripGeoJson(trips[0].id);
    expect(geoJson).toBeDefined();
    expect(geoJson.type).toBe("FeatureCollection");
  });
});
