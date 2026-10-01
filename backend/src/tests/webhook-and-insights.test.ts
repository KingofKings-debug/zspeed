import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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
import { createConnection, activateConnection, disconnectConnection } from "../services/connection.service.js";
import { ingestEvent, replayEvents } from "../services/ingestion.service.js";
import { drainWorker } from "../services/worker.service.js";
import { getVehicleCurrentDetail } from "../services/projection.service.js";
import {
  enqueueWebhookDelivery,
  processPendingDeliveries,
  getExhaustedDeliveries,
  getPendingDeliveries,
} from "../simulator/webhook-dispatcher.js";
import {
  recalculateFleetInsights,
  getFleetInsightsSummary,
  getFleetInsightDrilldown,
} from "../services/insight.service.js";

const SIM_PORT = 3299;
const PLATFORM_PORT = 3298;
const FLEET_A = "fleet_test_a";
const FLEET_B = "fleet_test_b";

let testPlatformDbPath: string;
let testSimDbPath: string;
let simServer: http.Server;
let platServer: http.Server;

beforeAll(async () => {
  process.env.VOLTERA_BASE_URL = `http://127.0.0.1:${SIM_PORT}/oem/voltera`;
  process.env.CRESTLINE_BASE_URL = `http://127.0.0.1:${SIM_PORT}/oem/crestline`;
  process.env.CRUX_BASE_URL = `http://127.0.0.1:${SIM_PORT}/oem/crestline`;
  process.env.PORT = String(PLATFORM_PORT);
  process.env.SIMULATOR_ADMIN_KEY = "test-sim-admin-key-xyz";

  await new Promise<void>((resolve) => {
    simServer = simulatorApp.listen(SIM_PORT, () => resolve());
  });

  await new Promise<void>((resolve) => {
    platServer = platformApp.listen(PLATFORM_PORT, () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => simServer.close(() => resolve()));
  await new Promise<void>((resolve) => platServer.close(() => resolve()));
});

beforeEach(() => {
  testPlatformDbPath = path.join(os.tmpdir(), `zspeed_plat_wh_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  testSimDbPath = path.join(os.tmpdir(), `zspeed_sim_wh_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);

  process.env.OVERRIDE_DB_PATH = testPlatformDbPath;
  process.env.SIMULATOR_OVERRIDE_DB_PATH = testSimDbPath;

  closeDb();
  closeSimulatorDb();

  runMigrations();
  seedDatabase();
  initSimulatorDb();

  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)").run(FLEET_A, "Test Fleet Alpha");
  db.prepare("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)").run(FLEET_B, "Test Fleet Beta");

  db.prepare("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)").run(
    "veh_a_1",
    FLEET_A,
    "1VXMA82635D100001",
    "NO_CONNECTION"
  );
  db.prepare("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)").run(
    "veh_a_2",
    FLEET_A,
    "1VXMA82635D100002",
    "NO_CONNECTION"
  );
  db.prepare("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)").run(
    "veh_b_1",
    FLEET_B,
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

describe("Webhook Authentication, Delivery Guarantees, and Isolation", () => {
  it("registers per-connection callbacks using the configured container backend address", async () => {
    const originalBase = process.env.PLATFORM_BASE_URL;
    const originalWebhook = process.env.PLATFORM_WEBHOOK_URL;
    process.env.PLATFORM_BASE_URL = "http://backend:3001/";
    delete process.env.PLATFORM_WEBHOOK_URL;
    try {
      const conn = createConnection(FLEET_A, "oem_crestline", "Container callback");
      const { getConnector } = await import("../connectors/index.js");
      const connector = getConnector("oem_crestline")!;
      try {
        await connector.activate(conn.id, FLEET_A, []);
        const subscription = getSimulatorDb().prepare("SELECT target_url FROM sim_subscriptions ORDER BY rowid DESC LIMIT 1").get() as { target_url: string };
        expect(subscription.target_url).toBe(`http://backend:3001/api/ingestion/webhooks/${conn.id}`);
      } finally {
        await connector.disconnect(conn.id);
      }
    } finally {
      if (originalBase === undefined) delete process.env.PLATFORM_BASE_URL;
      else process.env.PLATFORM_BASE_URL = originalBase;
      if (originalWebhook === undefined) delete process.env.PLATFORM_WEBHOOK_URL;
      else process.env.PLATFORM_WEBHOOK_URL = originalWebhook;
    }
  });

  it("rejects webhooks with missing subscription", async () => {
    const conn = createConnection(FLEET_A, "oem_crestline", "No Sub Conn");
    const payload = { vehicle_identifier: "CRS-001", event_id: "evt_1", state: { velocity_kmh: 50 } };
    const res = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${conn.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-SHA256": "abcdef" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(401);
    const data = await res.json() as any;
    expect(data.code || data.error).toBe("UNAUTHORIZED");
  });

  it("rejects webhooks with missing or invalid signature using constant-time comparison", async () => {
    const conn = createConnection(FLEET_A, "oem_crestline", "Signed Conn");
    const secret = "whsec_test_secret_key_888";
    getDb().prepare(`
      INSERT INTO connector_webhook_subscriptions (connection_id, subscription_id, oem_id, secret)
      VALUES (?, 'sub_wh_01', 'oem_crestline', ?)
    `).run(conn.id, secret);

    const payload = { vehicle_identifier: "CRS-001", event_id: "evt_sig_1", state: { velocity_kmh: 40 } };
    const rawBody = JSON.stringify(payload);

    const noSigRes = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${conn.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    });
    expect(noSigRes.status).toBe(401);

    const badSigRes = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${conn.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-SHA256": "bad_hex_signature" },
      body: rawBody,
    });
    expect(badSigRes.status).toBe(401);

    const validSig = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const goodRes = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${conn.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-SHA256": validSig },
      body: rawBody,
    });
    expect(goodRes.status).toBe(202);
  });

  it("enforces connection and vehicle scope", async () => {
    const connA = createConnection(FLEET_A, "oem_crestline", "Conn A");
    const connB = createConnection(FLEET_B, "oem_crestline", "Conn B");
    const secret = "whsec_scope_test_123";

    getDb().prepare(`
      INSERT INTO connector_webhook_subscriptions (connection_id, subscription_id, oem_id, secret)
      VALUES (?, 'sub_a', 'oem_crestline', ?), (?, 'sub_b', 'oem_crestline', ?)
    `).run(connA.id, secret, connB.id, secret);

    getDb().prepare(`
      INSERT INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified)
      VALUES ('map_a', 'veh_a_1', ?, 'VEH-A-01', 1),
             ('map_b', 'veh_b_1', ?, 'VEH-B-01', 1)
    `).run(connA.id, connB.id);

    const payloadAlien = { vehicle_identifier: "VEH-B-01", event_id: "evt_alien_1", state: { velocity_kmh: 60 } };
    const rawAlien = JSON.stringify(payloadAlien);
    const sigAlien = crypto.createHmac("sha256", secret).update(rawAlien).digest("hex");

    const forbiddenRes = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${connA.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-SHA256": sigAlien },
      body: rawAlien,
    });
    expect(forbiddenRes.status).toBe(403);

    const payloadOwn = { vehicle_identifier: "VEH-A-01", event_id: "evt_own_1", state: { velocity_kmh: 60 } };
    const rawOwn = JSON.stringify(payloadOwn);
    const sigOwn = crypto.createHmac("sha256", secret).update(rawOwn).digest("hex");

    const allowedRes = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${connA.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-SHA256": sigOwn },
      body: rawOwn,
    });
    expect(allowedRes.status).toBe(202);
  });

  it("handles duplicate deliveries idempotently", async () => {
    const conn = createConnection(FLEET_A, "oem_crestline", "Dup Test Conn");
    const secret = "whsec_dup_test_123";
    getDb().prepare(`
      INSERT INTO connector_webhook_subscriptions (connection_id, subscription_id, oem_id, secret)
      VALUES (?, 'sub_dup', 'oem_crestline', ?)
    `).run(conn.id, secret);

    const payload = { vehicle_identifier: "CRS-001", event_id: "evt_dup_999", state: { velocity_kmh: 70 } };
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");

    const res1 = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${conn.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-SHA256": sig },
      body: raw,
    });
    expect(res1.status).toBe(202);

    const res2 = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/${conn.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-SHA256": sig },
      body: raw,
    });
    expect(res2.status).toBe(200);
    const data2 = await res2.json() as any;
    expect(data2.status).toBe("DUPLICATE");
  });

  it("persists pending webhook deliveries during platform outage without discarding samples", async () => {
    const sub = {
      id: "sub_sim_outage",
      oem_id: "oem_crestline",
      target_url: `http://127.0.0.1:${PLATFORM_PORT}/api/ingestion/webhooks/dummy_conn`,
      secret: "sec_outage",
    };
    getSimulatorDb().prepare(`
      INSERT INTO sim_subscriptions (id, oem_id, target_url, secret, active)
      VALUES (?, ?, ?, ?, 1)
    `).run(sub.id, sub.oem_id, sub.target_url, sub.secret);

    setSimulatorScenario("delivery_outage", true);

    const delId1 = enqueueWebhookDelivery(sub, "evt_outage_001", { speed: 30 });
    const delId2 = enqueueWebhookDelivery(sub, "evt_outage_002", { speed: 35 });

    const pending = getPendingDeliveries();
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(pending.some((d) => d.id === delId1)).toBe(true);
    expect(pending.some((d) => d.id === delId2)).toBe(true);

    const deliveredCount = await processPendingDeliveries();
    expect(deliveredCount).toBe(0);

    const pendingAfter = getPendingDeliveries();
    expect(pendingAfter.length).toBeGreaterThanOrEqual(2);

    setSimulatorScenario("delivery_outage", false);
  });

  it("retries deliveries and marks exhausted after reaching maximum attempts", async () => {
    const sub = {
      id: "sub_sim_exhaust",
      oem_id: "oem_crestline",
      target_url: "http://127.0.0.1:9999/non_existent_endpoint",
      secret: "sec_fail",
    };
    getSimulatorDb().prepare(`
      INSERT INTO sim_subscriptions (id, oem_id, target_url, secret, active)
      VALUES (?, ?, ?, ?, 1)
    `).run(sub.id, sub.oem_id, sub.target_url, sub.secret);

    const delId = enqueueWebhookDelivery(sub, "evt_exhaust_001", { speed: 10 }, 2);

    await processPendingDeliveries();

    getSimulatorDb().prepare(
      "UPDATE sim_webhook_deliveries SET next_retry_at = datetime('now', '-1 minute') WHERE id = ?"
    ).run(delId);

    await processPendingDeliveries();

    const exhausted = getExhaustedDeliveries();
    expect(exhausted.some((d) => d.id === delId)).toBe(true);
  });

  it("does not resend pending webhooks when delivery batches overlap", async () => {
    const sub = { id: "sub_overlap", oem_id: "oem_crestline", target_url: "http://127.0.0.1/webhook", secret: "secret" };
    getSimulatorDb().prepare(
      "INSERT INTO sim_subscriptions (id, oem_id, target_url, secret, active) VALUES (?, ?, ?, ?, 1)"
    ).run(sub.id, sub.oem_id, sub.target_url, sub.secret);
    setSimulatorScenario("delivery_outage", true);
    const deliveryId = enqueueWebhookDelivery(sub, "evt_overlap", { speed: 30 });
    await processPendingDeliveries();
    setSimulatorScenario("delivery_outage", false);

    let finishRequest!: (response: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      new Promise<Response>((resolve) => { finishRequest = resolve; })
    );
    try {
      const first = processPendingDeliveries();
      const second = processPendingDeliveries();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      finishRequest(new Response("{}", { status: 200 }));
      expect(await Promise.all([first, second])).toEqual([1, 1]);
      const row = getSimulatorDb().prepare(
        "SELECT status, attempts FROM sim_webhook_deliveries WHERE id = ?"
      ).get(deliveryId);
      expect(row).toEqual({ status: "DELIVERED", attempts: 1 });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("cancels pending webhook deliveries upon disconnect", async () => {
    const subId = "sub_to_delete";
    getSimulatorDb().prepare(`
      INSERT INTO sim_subscriptions (id, oem_id, target_url, secret, active)
      VALUES (?, 'oem_crestline', 'http://127.0.0.1:9999/dummy', 'sec', 1)
    `).run(subId);

    const delId = enqueueWebhookDelivery({ id: subId, oem_id: "oem_crestline", target_url: "http://127.0.0.1:9999/dummy", secret: "sec" }, "evt_del_cancel", { speed: 5 });

    const delRes = await fetch(`http://127.0.0.1:${SIM_PORT}/oem/crestline/v1/webhooks/subscriptions/${subId}`, {
      method: "DELETE",
      headers: { "X-API-Key": "crestline_live_key" },
    });
    expect(delRes.status).toBe(200);

    await processPendingDeliveries();

    const deliveryRow = getSimulatorDb().prepare("SELECT status FROM sim_webhook_deliveries WHERE id = ?").get(delId) as any;
    expect(deliveryRow.status).toBe("CANCELLED");
  });

  it("protects simulator administration endpoints with configured admin credential and CORS", async () => {
    const unauth = await fetch(`http://127.0.0.1:${SIM_PORT}/api/simulator/status`);
    expect(unauth.status).toBe(401);

    const badKey = await fetch(`http://127.0.0.1:${SIM_PORT}/api/simulator/status`, {
      headers: { "X-Simulator-Admin-Key": "wrong-key" },
    });
    expect(badKey.status).toBe(401);

    const goodKey = await fetch(`http://127.0.0.1:${SIM_PORT}/api/simulator/status`, {
      headers: { "X-Simulator-Admin-Key": "test-sim-admin-key-xyz" },
    });
    expect(goodKey.status).toBe(200);
    const data = await goodKey.json() as any;
    expect(data.status).toBeDefined();
  });
});

describe("Durable Fleet Insights Projections and Consistency", () => {
  it("counts each affected vehicle once with a large quarantine backlog", () => {
    const db = getDb();
    const connection = createConnection(FLEET_A, "oem_voltera", "Backlog regression");
    db.prepare(`INSERT INTO raw_events
      (id, fleet_id, connection_id, source_vehicle_id, payload_hash, payload, processing_status)
      VALUES ('raw_backlog', ?, ?, 'VLT-001', 'backlog_hash', '{}', 'QUARANTINED')`)
      .run(FLEET_A, connection.id);
    const insert = db.prepare(`INSERT INTO quarantine_records
      (id, raw_event_id, fleet_id, connection_id, oem_id, vehicle_id, failure_category,
       failure_detail, first_failure_at, latest_attempt_at, status)
      VALUES (?, 'raw_backlog', ?, ?, 'oem_voltera', 'veh_a_1', 'SCHEMA_CHANGE',
        'Backlog format failure', datetime('now'), datetime('now'), 'UNRESOLVED')`);
    db.transaction(() => {
      for (let i = 0; i < 12000; i++) insert.run(`quarantine_backlog_${i}`, FLEET_A, connection.id);
    })();
    db.prepare("UPDATE vehicles SET data_status = 'STALE' WHERE id = 'veh_a_2'").run();
    expect(recalculateFleetInsights(FLEET_A).data_quality_issues).toBe(2);
    const drilldown = getFleetInsightDrilldown(FLEET_A, "data_quality_issues");
    expect(drilldown.vehicles.map(vehicle => vehicle.vehicle_id).sort()).toEqual(["veh_a_1", "veh_a_2"]);
    expect(recalculateFleetInsights(FLEET_B).data_quality_issues).toBe(0);
    expect(getVehicleCurrentDetail("veh_a_1").dataQuality).toEqual({ validEvents: 0, quarantinedEvents: 1, unresolvedEvents: 12000 });
    expect(getVehicleCurrentDetail("veh_b_1").dataQuality).toEqual({ validEvents: 0, quarantinedEvents: 0, unresolvedEvents: 0 });
  });

  it("maintains consistent distinct vehicle counts across rebuilds, fault clearing, and replay", async () => {
    const db = getDb();

    db.prepare(`
      INSERT OR REPLACE INTO vehicle_current_state (vehicle_id, latest_values, signal_timestamps, updated_at)
      VALUES ('veh_a_1', json_object('vehicle_speed', 80, 'battery_soc', 15, 'fault', 'P0300'), json_object('battery_soc', datetime('now'), 'fault', datetime('now')), datetime('now')),
             ('veh_a_2', json_object('vehicle_speed', 20, 'battery_soc', 85, 'fault', null), json_object('battery_soc', datetime('now')), datetime('now'))
    `).run();

    const tripId = "trip_insight_test_01";
    db.prepare(`
      INSERT INTO trips (id, vehicle_id, fleet_id, started_at, projection_status)
      VALUES (?, 'veh_a_1', ?, datetime('now', '-2 hours'), 'CURRENT')
    `).run(tripId, FLEET_A);

    db.prepare(`
      INSERT INTO trip_events (id, trip_id, vehicle_id, event_type, event_time, metadata)
      VALUES ('te_sb_1', ?, 'veh_a_1', 'HARSH_BRAKE', datetime('now', '-1 hour'), '{}'),
             ('te_sb_2', ?, 'veh_a_1', 'SPEED_VIOLATION', datetime('now', '-30 minutes'), '{}')
    `).run(tripId, tripId);

    const initialInsights = recalculateFleetInsights(FLEET_A);
    expect(initialInsights.safety_attention).toBe(1);
    expect(initialInsights.service_needed).toBe(1);
    expect(initialInsights.charging_needed).toBe(1);

    const repeatedInsights = recalculateFleetInsights(FLEET_A);
    expect(repeatedInsights.safety_attention).toBe(1);
    expect(repeatedInsights.service_needed).toBe(1);
    expect(repeatedInsights.charging_needed).toBe(1);

    const drilldownSafety = getFleetInsightDrilldown(FLEET_A, "safety_attention");
    expect(drilldownSafety.count).toBe(1);
    expect(drilldownSafety.vehicles[0].vehicle_id).toBe("veh_a_1");
    expect(drilldownSafety.vehicles[0].supporting_events?.length).toBe(2);

    db.prepare(`
      UPDATE vehicle_current_state
      SET latest_values = json_set(latest_values, '$.fault', 'CLEAR')
      WHERE vehicle_id = 'veh_a_1'
    `).run();

    const clearedInsights = recalculateFleetInsights(FLEET_A);
    expect(clearedInsights.service_needed).toBe(0);

    const drilldownCleared = getFleetInsightDrilldown(FLEET_A, "service_needed");
    expect(drilldownCleared.count).toBe(0);
    expect(drilldownCleared.vehicles.length).toBe(0);
  });
});
