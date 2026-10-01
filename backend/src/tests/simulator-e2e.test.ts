import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import http from "http";
import crypto from "crypto";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { getDb, closeDb } from "../db/pool.js";
import {
  getSimulatorDb,
  closeSimulatorDb,
  setSimulatorScenario,
  initSimulatorDb,
} from "../simulator/db.js";
import { engine } from "../simulator/engine.js";
import { app as simulatorApp } from "../simulator/server.js";
import { app as platformApp } from "../index.js";
import {
  createConnection,
  authorizeConnection,
  activateConnection,
  disconnectConnection,
} from "../services/connection.service.js";
import { ingestEvent, replayEvents } from "../services/ingestion.service.js";
import { drainWorker } from "../services/worker.service.js";
import { vehicleRepository } from "../repositories/vehicle.repository.js";
import { getConnector } from "../connectors/index.js";
import { deliverBatch } from "../services/delivery.service.js";

const SIM_PORT = 3199;
const PLATFORM_PORT = 3198;
const VOLTERA_URL = `http://127.0.0.1:${SIM_PORT}/oem/voltera`;
const CRESTLINE_URL = `http://127.0.0.1:${SIM_PORT}/oem/crestline`;
const FLEET_ID = "fleet_sim_test";

let testPlatformDbPath: string;
let testSimDbPath: string;
let simServer: http.Server;
let platServer: http.Server;

beforeAll(async () => {
  process.env.VOLTERA_BASE_URL = VOLTERA_URL;
  process.env.CRESTLINE_BASE_URL = CRESTLINE_URL;
  process.env.CRUX_BASE_URL = CRESTLINE_URL;
  process.env.PORT = String(PLATFORM_PORT);

  await new Promise<void>((resolve) => {
    simServer = simulatorApp.listen(SIM_PORT, () => {
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    platServer = platformApp.listen(PLATFORM_PORT, () => {
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    simServer.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    platServer.close(() => resolve());
  });
});

beforeEach(() => {
  testPlatformDbPath = path.join(os.tmpdir(), `zspeed_plat_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  testSimDbPath = path.join(os.tmpdir(), `zspeed_sim_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);

  process.env.OVERRIDE_DB_PATH = testPlatformDbPath;
  process.env.SIMULATOR_OVERRIDE_DB_PATH = testSimDbPath;

  closeDb();
  closeSimulatorDb();

  runMigrations();
  seedDatabase();
  initSimulatorDb();

  engine.reset(42, 6, 1.0);

  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)").run(FLEET_ID, "Simulator Test Fleet");
  db.prepare("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)").run(
    "veh_vlt_01",
    FLEET_ID,
    "1VXMA82635D100001",
    "NO_CONNECTION"
  );
  db.prepare("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)").run(
    "veh_crs_01",
    FLEET_ID,
    "2CRST96748E200001",
    "NO_CONNECTION"
  );
});

afterEach(() => {
  closeDb();
  closeSimulatorDb();

  try { fs.unlinkSync(testPlatformDbPath); } catch {}
  try { fs.unlinkSync(`${testPlatformDbPath}-wal`); } catch {}
  try { fs.unlinkSync(`${testPlatformDbPath}-shm`); } catch {}

  try { fs.unlinkSync(testSimDbPath); } catch {}
  try { fs.unlinkSync(`${testSimDbPath}-wal`); } catch {}
  try { fs.unlinkSync(`${testSimDbPath}-shm`); } catch {}
});

describe("Independent OEM Simulation Server and End-to-End Pipeline", () => {
  it("repairs existing Navarro mappings and processes simulator telemetry", async () => {
    process.env.NAVARRO_BASE_URL = `http://127.0.0.1:${SIM_PORT}/oem/navarro`;
    const db = getDb();
    db.prepare("DELETE FROM mapping_rules WHERE mapping_profile_id = 'prof_navarro_v1'").run();
    db.prepare("DELETE FROM mapping_profiles WHERE id = 'prof_navarro_v1'").run();
    db.prepare("DELETE FROM oem_format_versions WHERE id = 'fmt_navarro_telemetry_v1'").run();
    seedDatabase();
    seedDatabase();
    expect(db.prepare("SELECT COUNT(*) AS count FROM mapping_rules WHERE mapping_profile_id = 'prof_navarro_v1'").get()).toEqual({ count: 7 });
    engine.reset(42, 10, 1.0);
    engine.sampleTelemetry(true);
    db.prepare("INSERT INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, 'NO_CONNECTION')")
      .run("veh_nav_01", FLEET_ID, "3NAVR11859F300001");
    const connection = createConnection(FLEET_ID, "oem_navarro", "Navarro telemetry");
    try {
      expect((await authorizeConnection(connection.id, FLEET_ID, { username: "fleet" })).success).toBe(true);
      await activateConnection(connection.id, FLEET_ID, [{ oem_vehicle_id: "NAV-001", vin: "3NAVR11859F300001", categories: ["location", "odometer"] }]);
      expect(await deliverBatch(connection.id)).toBe(1);
      drainWorker();
      const vehicle = vehicleRepository.findByVin("3NAVR11859F300001", FLEET_ID);
      expect(vehicle?.data_status).toBe("RECEIVING");
      const event = db.prepare("SELECT canonical_values FROM normalized_events WHERE vehicle_id = 'veh_nav_01'").get() as { canonical_values: string };
      expect(JSON.parse(event.canonical_values)).toMatchObject({ ignition_status: "ON" });
      expect(JSON.parse(event.canonical_values).latitude).toBeTypeOf("number");
    } finally {
      await disconnectConnection(connection.id, FLEET_ID);
      delete process.env.NAVARRO_BASE_URL;
    }
  });
  it("discovers Navarro vehicles from the current simulator fleet", async () => {
    process.env.NAVARRO_BASE_URL = `http://127.0.0.1:${SIM_PORT}/oem/navarro`;
    try {
      engine.reset(42, 8, 1.0);
      const discovered = await getConnector("oem_navarro")!.discoverVehicles("navarro_test");
      const rows = getSimulatorDb().prepare(
        "SELECT id, vin FROM sim_vehicles WHERE oem_id = 'oem_navarro' ORDER BY id"
      ).all() as { id: string; vin: string }[];
      expect(discovered.map((vehicle) => ({ id: vehicle.oem_vehicle_id, vin: vehicle.vin }))).toEqual(rows);
      expect(discovered).toHaveLength(1);
    } finally {
      delete process.env.NAVARRO_BASE_URL;
    }
  });
  it("maintains continuous kinematic and physical vehicle transitions", () => {
    const simDb = getSimulatorDb();
    const v1Before = simDb.prepare("SELECT * FROM sim_vehicles WHERE id = 'VLT-001'").get() as any;
    const v4Before = simDb.prepare("SELECT * FROM sim_vehicles WHERE id = 'VLT-004'").get() as any;

    expect(v1Before.status).toBe("MOVING");
    expect(v4Before.status).toBe("CHARGING");

    engine.advancePhysics(2.0);

    const v1After = simDb.prepare("SELECT * FROM sim_vehicles WHERE id = 'VLT-001'").get() as any;
    const v4After = simDb.prepare("SELECT * FROM sim_vehicles WHERE id = 'VLT-004'").get() as any;

    expect(v1After.odometer).toBeGreaterThan(v1Before.odometer);
    expect(v1After.route_progress).toBeGreaterThan(v1Before.route_progress);
    expect(v1After.soc).toBeLessThanOrEqual(v1Before.soc);

    expect(v4After.speed).toBe(0);
    expect(v4After.soc).toBeGreaterThan(v4Before.soc);
  });

  it("produces stable and immutable source telemetry events across repeated calls", async () => {
    engine.sampleTelemetry(true);

    const res1 = await fetch(`${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/latest`, {
      headers: { Authorization: "Bearer demo_valid_token" },
    });
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as any;

    const res2 = await fetch(`${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/latest`, {
      headers: { Authorization: "Bearer demo_valid_token" },
    });
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as any;

    expect(data1.event_id).toBe(data2.event_id);
    expect(data1.source_timestamp).toBe(data2.source_timestamp);
    expect(data1.payload.speed_mph).toBe(data2.payload.speed_mph);
    expect(data1.payload.odo_miles).toBe(data2.payload.odo_miles);
  });

  it("enforces independent authorization and per-vehicle discovery contracts", async () => {
    const unauthRes = await fetch(`${VOLTERA_URL}/v1/vehicles`);
    expect(unauthRes.status).toBe(401);

    const tokenRes = await fetch(`${VOLTERA_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "valid" }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenData = (await tokenRes.json()) as any;
    expect(tokenData.access_token).toBeDefined();

    const authRes = await fetch(`${VOLTERA_URL}/v1/vehicles`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    expect(authRes.status).toBe(200);
    const discovery = (await authRes.json()) as any;
    expect(discovery.vehicles.length).toBeGreaterThan(0);
    expect(discovery.vehicles.some((v: any) => v.oem_vehicle_id === "VLT-001")).toBe(true);

    const crsBad = await fetch(`${CRESTLINE_URL}/v1/fleet/vehicles`, {
      headers: { "X-API-Key": "fail" },
    });
    expect(crsBad.status).toBe(401);

    const crsGood = await fetch(`${CRESTLINE_URL}/v1/fleet/vehicles`, {
      headers: { "X-API-Key": "crestline_live_key" },
    });
    expect(crsGood.status).toBe(200);
  });

  it("supports paginated discovery and incremental cursor history recovery", async () => {
    const p1Res = await fetch(`${VOLTERA_URL}/v1/vehicles?page=1&limit=2`, {
      headers: { Authorization: "Bearer demo_valid_token" },
    });
    const p1 = (await p1Res.json()) as any;
    expect(p1.vehicles.length).toBe(2);
    expect(p1.has_more).toBe(true);

    for (let i = 0; i < 4; i++) {
      engine.advancePhysics(3.0);
      engine.sampleTelemetry(true);
    }

    const hist1Res = await fetch(`${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/history?cursor=0&limit=2`, {
      headers: { Authorization: "Bearer demo_valid_token" },
    });
    const hist1 = (await hist1Res.json()) as any;
    expect(hist1.events.length).toBe(2);
    expect(hist1.next_cursor).toBeDefined();

    const hist2Res = await fetch(
      `${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/history?cursor=${hist1.next_cursor}&limit=2`,
      { headers: { Authorization: "Bearer demo_valid_token" } }
    );
    const hist2 = (await hist2Res.json()) as any;
    expect(hist2.events.length).toBeGreaterThan(0);
    expect(hist2.events[0].sequence).toBeGreaterThan(hist1.events[1].sequence);
  });

  it("handles rate-limiting headers and retry backoff", async () => {
    setSimulatorScenario("rate_limit", true);

    const res = await fetch(`${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/latest`, {
      headers: { Authorization: "Bearer demo_valid_token" },
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");

    setSimulatorScenario("rate_limit", false);

    const resRecovered = await fetch(`${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/latest`, {
      headers: { Authorization: "Bearer demo_valid_token" },
    });
    expect(resRecovered.status).toBe(200);
  });

  it("verifies webhook HMAC signatures and ensures idempotent receipt", async () => {
    const conn = createConnection(FLEET_ID, "oem_crestline", "Crestline Webhook Conn");
    const secret = "test_webhook_secret_key_123";

    const db = getDb();
    db.prepare(`
      INSERT INTO connector_webhook_subscriptions (connection_id, subscription_id, oem_id, secret)
      VALUES (?, 'sub_test_01', 'oem_crestline', ?)
    `).run(conn.id, secret);

    const payload = {
      vehicle_identifier: "CRS-001",
      event_id: "evt_webhook_test_001",
      time_measured: Date.now(),
      state: {
        velocity_kmh: 45,
        distance_km: 12000,
        ignition: true,
        battery_pct: 80,
        gps_lat: 51.5074,
        gps_lon: -0.1278,
      },
    };

    const rawBody = JSON.stringify(payload);
    const validSignature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    const badSigRes = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${conn.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-SHA256": "invalid_sig_abc",
      },
      body: rawBody,
    });
    expect(badSigRes.status).toBe(401);

    const goodRes = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${conn.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-SHA256": validSignature,
      },
      body: rawBody,
    });
    expect(goodRes.status).toBe(202);

    const dupRes = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${conn.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-SHA256": validSignature,
      },
      body: rawBody,
    });
    expect(dupRes.status).toBe(200);
    const dupData = (await dupRes.json()) as any;
    expect(dupData.status).toBe("DUPLICATE");
  });

  it("handles delivery outage followed by catch-up via history endpoint", async () => {
    engine.sampleTelemetry(true);

    const initRes = await fetch(`${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/latest`, {
      headers: { Authorization: "Bearer demo_valid_token" },
    });
    const initData = (await initRes.json()) as any;
    const initialSeq = initData.sequence;

    setSimulatorScenario("delivery_outage", true);

    const outageRes = await fetch(`${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/latest`, {
      headers: { Authorization: "Bearer demo_valid_token" },
    });
    expect(outageRes.status).toBe(503);

    for (let i = 0; i < 3; i++) {
      engine.advancePhysics(3.0);
      engine.sampleTelemetry(true);
    }

    setSimulatorScenario("delivery_outage", false);

    const catchUpRes = await fetch(
      `${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/history?cursor=${initialSeq}&limit=10`,
      { headers: { Authorization: "Bearer demo_valid_token" } }
    );
    expect(catchUpRes.status).toBe(200);
    const catchUpData = (await catchUpRes.json()) as any;
    expect(catchUpData.events.length).toBeGreaterThanOrEqual(3);
    expect(catchUpData.events[0].sequence).toBeGreaterThan(initialSeq);
  });

  it("quarantines breaking OEM format and allows replay recovery after mapping update", async () => {
    const conn = createConnection(FLEET_ID, "oem_voltera", "Breaking Format Test");
    await authorizeConnection(conn.id, FLEET_ID, {
      username: "admin",
      password: "valid",
    });
    await activateConnection(conn.id, FLEET_ID, [
      { oem_vehicle_id: "VLT-001", vin: "1VXMA82635D100001", categories: ["location"] },
    ]);

    setSimulatorScenario("breaking_schema", true);
    engine.sampleTelemetry(true);

    const simDb = getSimulatorDb();
    const sample = simDb
      .prepare("SELECT * FROM sim_samples WHERE oem_id = 'oem_voltera' AND vehicle_id = 'VLT-001' ORDER BY sample_seq DESC LIMIT 1")
      .get() as any;

    const payload = JSON.parse(sample.payload);
    expect(payload.telemetry_v3).toBeDefined();

    const ingestRes = ingestEvent(FLEET_ID, conn.id, "VLT-001", payload, sample.id, true);
    expect(ingestRes.status).toBe("ACCEPTED");

    drainWorker();

    const rawEvent = getDb()
      .prepare("SELECT * FROM raw_events WHERE id = ?")
      .get(ingestRes.eventId) as any;
    expect(rawEvent.processing_status).toBe("QUARANTINED");

    const incident = getDb()
      .prepare("SELECT * FROM quarantine_incidents WHERE fleet_id = ? AND oem_id = 'oem_voltera'")
      .get(FLEET_ID) as any;
    expect(incident).toBeDefined();

    const fmtId = `fmt_voltera_v3_${Date.now()}`;
    const db = getDb();
    db.prepare(`
      INSERT INTO oem_format_versions (id, oem_id, event_type, format_version, expected_structure)
      VALUES (?, 'oem_voltera', 'telemetry', 'v3', ?)
    `).run(
      fmtId,
      JSON.stringify({
        required_fields: [
          { path: "telemetry_v3.speed_kph", type: "number" },
          { path: "telemetry_v3.battery_percent", type: "number" },
          { path: "timestamp", type: "string", is_time: true },
        ],
      })
    );

    const profileId = `prof_voltera_v3_${Date.now()}`;
    db.prepare(`
      INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status)
      VALUES (?, ?, '1.0', '1.0', 'ACTIVE')
    `).run(profileId, fmtId);

    db.prepare(`
      INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type)
      VALUES (?, ?, 'telemetry_v3.speed_kph', 'sig_speed', 'DIRECT')
    `).run(crypto.randomUUID(), profileId);

    db.prepare(`
      INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type)
      VALUES (?, ?, 'telemetry_v3.battery_percent', 'sig_soc', 'DIRECT')
    `).run(crypto.randomUUID(), profileId);

    db.prepare(`
      INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type)
      VALUES (?, ?, 'timestamp', 'sig_event_time', 'DIRECT')
    `).run(crypto.randomUUID(), profileId);

    const replayRes = replayEvents(profileId, {
      fleet_id: FLEET_ID,
      raw_event_ids: [rawEvent.id],
    });
    expect(replayRes.jobId).toBeDefined();

    drainWorker();

    const reprocessedRaw = getDb()
      .prepare("SELECT * FROM raw_events WHERE id = ?")
      .get(rawEvent.id) as any;
    expect(reprocessedRaw.processing_status).toBe("PROCESSED");

    const normalized = getDb()
      .prepare("SELECT * FROM normalized_events WHERE raw_event_id = ?")
      .get(rawEvent.id) as any;
    expect(normalized).toBeDefined();

    setSimulatorScenario("breaking_schema", false);
  });

  it("guarantees complete isolation with zero direct simulator writes to platform database", () => {
    const platformDb = getDb();
    const simDb = getSimulatorDb();

    const platformRawCountBefore = (
      platformDb.prepare("SELECT COUNT(*) as c FROM raw_events").get() as any
    ).c;

    engine.advancePhysics(5.0);
    engine.sampleTelemetry(true);

    const platformRawCountAfter = (
      platformDb.prepare("SELECT COUNT(*) as c FROM raw_events").get() as any
    ).c;
    expect(platformRawCountAfter).toBe(platformRawCountBefore);

    const simSamplesCount = (
      simDb.prepare("SELECT COUNT(*) as c FROM sim_samples").get() as any
    ).c;
    expect(simSamplesCount).toBeGreaterThan(0);
  });

  it("updates live vehicle state through connector delivery into platform", async () => {
    const conn = createConnection(FLEET_ID, "oem_voltera", "Live Flow Connection");
    await authorizeConnection(conn.id, FLEET_ID, {
      username: "admin",
      password: "valid",
    });

    await activateConnection(conn.id, FLEET_ID, [
      { oem_vehicle_id: "VLT-001", vin: "1VXMA82635D100001", categories: ["location"] },
    ]);

    engine.sampleTelemetry(true);

    const sample = getSimulatorDb()
      .prepare("SELECT * FROM sim_samples WHERE oem_id = 'oem_voltera' AND vehicle_id = 'VLT-001' ORDER BY sample_seq DESC LIMIT 1")
      .get() as any;

    const ingestRes = ingestEvent(
      FLEET_ID,
      conn.id,
      "VLT-001",
      JSON.parse(sample.payload),
      sample.id,
      true
    );
    expect(ingestRes.status).toBe("ACCEPTED");

    drainWorker();

    const vehicle = vehicleRepository.findById("veh_vlt_01", FLEET_ID);
    expect(vehicle?.data_status).toBe("RECEIVING");

    const currentState = getDb()
      .prepare("SELECT * FROM vehicle_current_state WHERE vehicle_id = 'veh_vlt_01'")
      .get() as any;
    expect(currentState).toBeDefined();
    const values = JSON.parse(currentState.latest_values);
    expect(values.vehicle_speed).toBeDefined();

    await disconnectConnection(conn.id, FLEET_ID);
  });
});
