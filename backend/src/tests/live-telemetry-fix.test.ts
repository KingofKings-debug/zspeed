import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import type { Server } from "http";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { getDb, closeDb } from "../db/pool.js";
import { httpServer } from "../index.js";
import { processRawEvent } from "../services/ingestion.service.js";
import { computeVehicleLiveState, computeMovementState, computeDataFreshness } from "../services/vehicle-state.service.js";
import { getCatchupEvents } from "../services/fleet-event.service.js";
import { engine } from "../simulator/engine.js";
import { getSimulatorDb, initSimulatorDb } from "../simulator/db.js";
import { v4 as uuid } from "uuid";

const TEST_FLEET = "fleet_telemetry_test";
const TEST_CONN = "conn_telemetry_test";
const TEST_VEHICLE = "veh_telemetry_001";
const TEST_PARKED_VEHICLE = "veh_telemetry_parked";

let testDbPath: string;
let server: Server;
let baseUrl: string;

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params);
}

function queryOne<T = any>(sql: string, params: any[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T;
}

function ingestVoltEvent(
  fleetId: string,
  connId: string,
  sourceVehId: string,
  sourceEvtId: string,
  data: {
    timestamp: string;
    speed_mph: number;
    lat?: number;
    lon?: number;
    odo_miles?: number;
    charge_fraction?: number;
    status?: string;
  }
) {
  const payloadStr = JSON.stringify({
    timestamp: data.timestamp,
    speed_mph: data.speed_mph,
    charge_fraction: data.charge_fraction ?? 0.85,
    odo_miles: data.odo_miles ?? 15000,
    status: data.status ?? "running",
    lat: data.lat,
    lon: data.lon,
    altitude: 20,
    heading: 90,
  });

  const rawId = uuid();
  run(
    `INSERT INTO raw_events (id, fleet_id, connection_id, source_event_id, source_vehicle_id, payload_hash, payload, processing_status, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    [rawId, fleetId, connId, sourceEvtId, sourceVehId, `hash_${rawId}`, payloadStr, `${connId}:${sourceEvtId}`]
  );

  return processRawEvent(rawId);
}

describe("Live Telemetry and Simulator Architecture Fixes", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = httpServer.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    initSimulatorDb();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  beforeEach(() => {
    testDbPath = path.join(os.tmpdir(), `zspeed-telem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.OVERRIDE_DB_PATH = testDbPath;
    closeDb();
    runMigrations();
    seedDatabase();

    run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [TEST_FLEET, "Telemetry Fleet"]);
    run(
      "INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
      [TEST_CONN, TEST_FLEET, "oem_voltera", "Voltera Conn", "ACTIVE"]
    );
    run(
      "INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, label, data_status, connection_id) VALUES (?, ?, ?, ?, ?, ?)",
      [TEST_VEHICLE, TEST_FLEET, "1VLTTEST0000000001", "Live Test Vehicle", "AWAITING_DATA", TEST_CONN]
    );
    run(
      "INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES (?, ?, ?, ?, ?)",
      [uuid(), TEST_VEHICLE, TEST_CONN, "VLT-TEST-01", 1]
    );
    run(
      "INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, label, data_status, connection_id) VALUES (?, ?, ?, ?, ?, ?)",
      [TEST_PARKED_VEHICLE, TEST_FLEET, "1VLTTEST0000000002", "Parked Vehicle", "AWAITING_DATA", TEST_CONN]
    );
    run(
      "INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES (?, ?, ?, ?, ?)",
      [uuid(), TEST_PARKED_VEHICLE, TEST_CONN, "VLT-TEST-02", 1]
    );
  });

  afterEach(() => {
    closeDb();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
      if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
    } catch {}
  });

  it("advances simulator speed, route progress, and position continuously across ticks", () => {
    engine.reset(42, 6, 1.0);
    const db = getSimulatorDb();

    const initialVehicles = db.prepare("SELECT * FROM sim_vehicles WHERE status = 'MOVING'").all() as any[];
    expect(initialVehicles.length).toBeGreaterThan(0);
    const initial = initialVehicles[0];

    for (let i = 0; i < 5; i++) {
      engine.advancePhysics(1.0);
    }

    const updated = db.prepare("SELECT * FROM sim_vehicles WHERE id = ?").get(initial.id) as any;
    expect(updated).toBeDefined();
    expect(updated.route_progress).not.toBe(initial.route_progress);
    expect(updated.odometer).toBeGreaterThan(initial.odometer);
    expect(updated.lat !== initial.lat || updated.lon !== initial.lon).toBe(true);
  });

  it("ensures parked vehicles remain stationary with 0 km/h speed across ticks", () => {
    engine.reset(42, 6, 1.0);
    const db = getSimulatorDb();

    db.prepare(`
      UPDATE sim_vehicles 
      SET status = 'PARKED', speed = 0, target_speed = 0, acceleration = 0, ignition = 'OFF'
      WHERE id = 'VLT-003'
    `).run();

    const before = db.prepare("SELECT * FROM sim_vehicles WHERE id = 'VLT-003'").get() as any;
    expect(before.speed).toBe(0);
    expect(before.ignition).toBe("OFF");

    for (let i = 0; i < 10; i++) {
      engine.advancePhysics(1.0);
    }

    const after = db.prepare("SELECT * FROM sim_vehicles WHERE id = 'VLT-003'").get() as any;
    expect(after.speed).toBe(0);
    expect(after.status).toBe("PARKED");
    expect(after.ignition).toBe("OFF");
    expect(after.lat).toBe(before.lat);
    expect(after.lon).toBe(before.lon);
  });

  it("cycles deterministic demonstration scenario through acceleration, cruise, brake, and stop", () => {
    engine.reset(12345, 6, 1.0);
    const db = getSimulatorDb();

    engine.advancePhysics(5.0);
    let v = db.prepare("SELECT * FROM sim_vehicles WHERE id = 'VLT-001'").get() as any;
    expect(v.speed).toBeGreaterThan(0);

    engine.advancePhysics(10.0);
    v = db.prepare("SELECT * FROM sim_vehicles WHERE id = 'VLT-001'").get() as any;
    expect(v.speed).toBeCloseTo(50, 0);

    engine.advancePhysics(25.0);
    v = db.prepare("SELECT * FROM sim_vehicles WHERE id = 'VLT-001'").get() as any;
    expect(v.speed).toBe(0);
    expect(v.status).toBe("IDLE");

    engine.advancePhysics(15.0);
    v = db.prepare("SELECT * FROM sim_vehicles WHERE id = 'VLT-001'").get() as any;
    expect(v.speed).toBeGreaterThan(0);
    expect(v.status).toBe("MOVING");
  });

  it("normalizes speed correctly into canonical unit km/h", async () => {
    const resMps = ingestVoltEvent(
      TEST_FLEET,
      TEST_CONN,
      "VLT-TEST-01",
      `evt_norm_${Date.now()}`,
      {
        timestamp: new Date().toISOString(),
        speed_mph: 60.0,
        lat: 37.7749,
        lon: -122.4194,
        charge_fraction: 0.88,
      }
    );
    expect(resMps.status).toBe("PROCESSED");

    const state = queryOne("SELECT * FROM vehicle_current_state WHERE vehicle_id = ?", [TEST_VEHICLE]);
    expect(state).toBeDefined();
    const vals = JSON.parse(state.latest_values);
    expect(vals.vehicle_speed).toBeCloseTo(96.56, 1);
  });

  it("merges partial signal updates into current state without clearing other latest values", async () => {
    const t0 = new Date("2026-10-01T10:00:00Z").toISOString();
    ingestVoltEvent(
      TEST_FLEET,
      TEST_CONN,
      "VLT-TEST-01",
      `evt_full_${Date.now()}`,
      {
        timestamp: t0,
        speed_mph: 45.0,
        lat: 37.7749,
        lon: -122.4194,
        odo_miles: 12000,
        charge_fraction: 0.85,
      }
    );

    const state1 = queryOne("SELECT * FROM vehicle_current_state WHERE vehicle_id = ?", [TEST_VEHICLE]);
    expect(state1).toBeDefined();
    const vals1 = JSON.parse(state1.latest_values);
    expect(vals1.vehicle_speed).toBeCloseTo(72.42, 1);
    expect(vals1.latitude).toBeCloseTo(37.7749, 4);
    expect(vals1.battery_soc).toBe(85);

    const t1 = new Date("2026-10-01T10:01:00Z").toISOString();
    ingestVoltEvent(
      TEST_FLEET,
      TEST_CONN,
      "VLT-TEST-01",
      `evt_part_${Date.now()}`,
      {
        timestamp: t1,
        speed_mph: 45.0,
        charge_fraction: 0.82,
      }
    );

    const state2 = queryOne("SELECT * FROM vehicle_current_state WHERE vehicle_id = ?", [TEST_VEHICLE]);
    const vals2 = JSON.parse(state2.latest_values);
    expect(vals2.battery_soc).toBe(82);
    expect(vals2.vehicle_speed).toBeCloseTo(72.42, 1);
    expect(vals2.latitude).toBeCloseTo(37.7749, 4);
    expect(vals2.longitude).toBeCloseTo(-122.4194, 4);
  });

  it("ignores delayed out-of-order signals for current state while retaining newer values", async () => {
    const tNewer = new Date("2026-10-01T12:10:00Z").toISOString();
    ingestVoltEvent(
      TEST_FLEET,
      TEST_CONN,
      "VLT-TEST-01",
      `evt_newer_${Date.now()}`,
      {
        timestamp: tNewer,
        speed_mph: 55.0,
        lat: 37.8000,
        lon: -122.4000,
      }
    );

    const stateNewer = queryOne("SELECT * FROM vehicle_current_state WHERE vehicle_id = ?", [TEST_VEHICLE]);
    const valsNewer = JSON.parse(stateNewer.latest_values);
    expect(valsNewer.vehicle_speed).toBeCloseTo(88.51, 1);
    expect(valsNewer.latitude).toBeCloseTo(37.8000, 4);

    const tOlder = new Date("2026-10-01T12:05:00Z").toISOString();
    const resOlder = ingestVoltEvent(
      TEST_FLEET,
      TEST_CONN,
      "VLT-TEST-01",
      `evt_older_${Date.now()}`,
      {
        timestamp: tOlder,
        speed_mph: 20.0,
        lat: 37.7500,
        lon: -122.4500,
      }
    );
    expect(resOlder.status).toBe("PROCESSED");

    const stateAfterOlder = queryOne("SELECT * FROM vehicle_current_state WHERE vehicle_id = ?", [TEST_VEHICLE]);
    const valsAfter = JSON.parse(stateAfterOlder.latest_values);
    expect(valsAfter.vehicle_speed).toBeCloseTo(88.51, 1);
    expect(valsAfter.latitude).toBeCloseTo(37.8000, 4);
  });

  it("pushes committed latest values with movement state and canonical speed via Socket.IO", async () => {
    const client: ClientSocket = Client(baseUrl, {
      auth: { fleetId: TEST_FLEET },
      transports: ["websocket", "polling"],
      reconnection: false,
    });

    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => resolve());
      client.on("connect_error", (e) => reject(e));
    });

    const pushPromise = new Promise<any>((resolve) => {
      client.on("fleet:event", (msg) => {
        if (msg.eventType === "vehicle:telemetry" && msg.vehicleId === TEST_VEHICLE) {
          resolve(msg);
        }
      });
    });

    ingestVoltEvent(
      TEST_FLEET,
      TEST_CONN,
      "VLT-TEST-01",
      `evt_socket_push_${Date.now()}`,
      {
        timestamp: new Date().toISOString(),
        speed_mph: 35.0,
        lat: 37.7788,
        lon: -122.4155,
        charge_fraction: 0.92,
        status: "running",
      }
    );

    const msg = await pushPromise;
    expect(msg).toBeDefined();
    expect(msg.payload.speed).toBeCloseTo(56.33, 1);
    expect(msg.payload.speed_unit).toBe("km/h");
    expect(msg.payload.movement_state).toBe("MOVING");
    expect(msg.payload.data_freshness).toBe("LIVE");
    expect(msg.payload.latitude).toBeCloseTo(37.7788, 4);
    expect(msg.payload.longitude).toBeCloseTo(-122.4155, 4);

    client.disconnect();
  });

  it("recovers missed events on reconnect via catch-up query", () => {
    ingestVoltEvent(
      TEST_FLEET,
      TEST_CONN,
      "VLT-TEST-01",
      `evt_catchup_${Date.now()}`,
      {
        timestamp: new Date().toISOString(),
        speed_mph: 30.0,
        lat: 37.77,
        lon: -122.41,
      }
    );

    const res = getCatchupEvents(TEST_FLEET, 0, 50);
    expect(Array.isArray(res.events)).toBe(true);
    expect(res.events.length).toBeGreaterThan(0);
    expect(res.latestSequence).toBeGreaterThan(0);
    expect(res.events[0].sequence).toBeGreaterThan(0);
  });

  it("correctly separates movement state from data freshness", () => {
    const movingLive = computeVehicleLiveState({
      hasActiveConnection: true,
      speed: 45,
      ignition: "ON",
      lastReceiptTime: new Date().toISOString(),
    });
    expect(movingLive).toBe("MOVING");

    const idleLive = computeVehicleLiveState({
      hasActiveConnection: true,
      speed: 0,
      ignition: "ON",
      lastReceiptTime: new Date().toISOString(),
    });
    expect(idleLive).toBe("IDLE");

    const tenMinsAgo = new Date(Date.now() - 600000).toISOString();
    const staleState = computeVehicleLiveState({
      hasActiveConnection: true,
      speed: 50,
      ignition: "ON",
      lastReceiptTime: tenMinsAgo,
    });
    expect(staleState).toBe("OFFLINE");

    expect(computeMovementState(50, "ON")).toBe("MOVING");
    expect(computeMovementState(0, "ON")).toBe("IDLE");
    expect(computeMovementState(0, "OFF")).toBe("PARKED");

    expect(computeDataFreshness({ hasActiveConnection: true, lastReceiptTime: new Date().toISOString() })).toBe("LIVE");
    expect(computeDataFreshness({ hasActiveConnection: true, lastReceiptTime: new Date(Date.now() - 70000).toISOString() })).toBe("STALE");
    expect(computeDataFreshness({ hasActiveConnection: true, lastReceiptTime: tenMinsAgo })).toBe("OFFLINE");
  });

  it("verifies simulator controls are absent from fleet-manager application files", () => {
    const frontendAppPath = path.resolve(__dirname, "../../../frontend/src/App.tsx");
    const frontendApiPath = path.resolve(__dirname, "../../../frontend/src/api.ts");
    const simControlPath = path.resolve(__dirname, "../../../frontend/src/components/SimulatorControl.tsx");

    expect(fs.existsSync(simControlPath)).toBe(false);

    const appCode = fs.readFileSync(frontendAppPath, "utf-8");
    expect(appCode).not.toContain("SimulatorControl");
    expect(appCode).not.toContain("view === \"simulator\"");
    expect(appCode).not.toContain("OEM Simulator");

    const apiCode = fs.readFileSync(frontendApiPath, "utf-8");
    expect(apiCode).not.toContain("getSimStatus");
    expect(apiCode).not.toContain("/sim-api");
    expect(apiCode).not.toContain("simRequest");
  });
});
