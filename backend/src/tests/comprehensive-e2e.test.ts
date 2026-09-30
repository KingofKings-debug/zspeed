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
} from "../services/connection.service.js";
import { ingestEvent, replayEvents } from "../services/ingestion.service.js";
import { drainWorker } from "../services/worker.service.js";
import { vehicleRepository } from "../repositories/vehicle.repository.js";
import { recalculateFleetInsights, getFleetInsightsSummary } from "../services/insight.service.js";
import { buildProjectionsForVehicle } from "../services/projection.service.js";

const SIM_PORT = 3399;
const PLATFORM_PORT = 3398;
const FLEET_ID = "fleet_comprehensive_e2e";
const VOLTERA_URL = `http://127.0.0.1:${SIM_PORT}/oem/voltera`;

let testPlatformDbPath: string;
let testSimDbPath: string;
let simServer: http.Server;
let platServer: http.Server;

beforeAll(async () => {
  process.env.VOLTERA_BASE_URL = VOLTERA_URL;
  process.env.PORT = String(PLATFORM_PORT);
  process.env.SIMULATOR_ADMIN_KEY = "sim-e2e-secret-key";

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
  testPlatformDbPath = path.join(os.tmpdir(), `zspeed_plat_comp_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  testSimDbPath = path.join(os.tmpdir(), `zspeed_sim_comp_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);

  process.env.OVERRIDE_DB_PATH = testPlatformDbPath;
  process.env.SIMULATOR_OVERRIDE_DB_PATH = testSimDbPath;

  closeDb();
  closeSimulatorDb();

  runMigrations();
  seedDatabase();
  initSimulatorDb();

  engine.reset(1001, 8, 1.0);

  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)").run(FLEET_ID, "Comprehensive E2E Fleet");

  db.prepare("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)").run(
    "veh_vlt_1",
    FLEET_ID,
    "1VXMA82635D100001",
    "NO_CONNECTION"
  );
  db.prepare("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)").run(
    "veh_vlt_2",
    FLEET_ID,
    "1VXMA82635D100002",
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

describe("Comprehensive End-to-End Ingestion, Recovery, Replay, and Insight Scenario", () => {
  it("executes the full lifecycle across vehicles, outages, schema breaks, replay, and stable totals", async () => {
    const conn = createConnection(FLEET_ID, "oem_voltera", "Voltera Fleet Connection");
    await authorizeConnection(conn.id, FLEET_ID, {
      username: "admin",
      password: "valid",
    });

    await activateConnection(conn.id, FLEET_ID, [
      { oem_vehicle_id: "VLT-001", vin: "1VXMA82635D100001", categories: ["location", "odometer"] },
      { oem_vehicle_id: "VLT-002", vin: "1VXMA82635D100002", categories: ["location", "odometer"] },
    ]);

    engine.advancePhysics(2.0);
    engine.sampleTelemetry(true);

    const simDb = getSimulatorDb();
    const sample1_v1 = simDb
      .prepare("SELECT * FROM sim_samples WHERE vehicle_id = 'VLT-001' ORDER BY sample_seq DESC LIMIT 1")
      .get() as any;
    const sample1_v2 = simDb
      .prepare("SELECT * FROM sim_samples WHERE vehicle_id = 'VLT-002' ORDER BY sample_seq DESC LIMIT 1")
      .get() as any;

    expect(sample1_v1).toBeDefined();
    expect(sample1_v2).toBeDefined();

    ingestEvent(FLEET_ID, conn.id, "VLT-001", JSON.parse(sample1_v1.payload), sample1_v1.id, true);
    ingestEvent(FLEET_ID, conn.id, "VLT-002", JSON.parse(sample1_v2.payload), sample1_v2.id, true);
    drainWorker();

    const stateV1_init = getDb().prepare("SELECT * FROM vehicle_current_state WHERE vehicle_id = 'veh_vlt_1'").get() as any;
    const stateV2_init = getDb().prepare("SELECT * FROM vehicle_current_state WHERE vehicle_id = 'veh_vlt_2'").get() as any;
    expect(stateV1_init).toBeDefined();
    expect(stateV2_init).toBeDefined();

    const parsedV1_init = JSON.parse(stateV1_init.latest_values);
    const parsedV2_init = JSON.parse(stateV2_init.latest_values);

    engine.advancePhysics(5.0);
    engine.sampleTelemetry(true);

    const sample2_v1 = simDb
      .prepare("SELECT * FROM sim_samples WHERE vehicle_id = 'VLT-001' ORDER BY sample_seq DESC LIMIT 1")
      .get() as any;
    const sample2_v2 = simDb
      .prepare("SELECT * FROM sim_samples WHERE vehicle_id = 'VLT-002' ORDER BY sample_seq DESC LIMIT 1")
      .get() as any;

    ingestEvent(FLEET_ID, conn.id, "VLT-001", JSON.parse(sample2_v1.payload), sample2_v1.id, true);
    ingestEvent(FLEET_ID, conn.id, "VLT-002", JSON.parse(sample2_v2.payload), sample2_v2.id, true);
    drainWorker();

    const stateV1_moved = getDb().prepare("SELECT * FROM vehicle_current_state WHERE vehicle_id = 'veh_vlt_1'").get() as any;
    const stateV2_moved = getDb().prepare("SELECT * FROM vehicle_current_state WHERE vehicle_id = 'veh_vlt_2'").get() as any;
    const parsedV1_moved = JSON.parse(stateV1_moved.latest_values);
    const parsedV2_moved = JSON.parse(stateV2_moved.latest_values);

    expect(parsedV1_moved.odometer).toBeGreaterThanOrEqual(parsedV1_init.odometer);
    expect(parsedV2_moved.odometer).toBeGreaterThanOrEqual(parsedV2_init.odometer);

    const veh1 = vehicleRepository.findById("veh_vlt_1", FLEET_ID);
    const veh2 = vehicleRepository.findById("veh_vlt_2", FLEET_ID);
    expect(veh1?.data_status).toBe("RECEIVING");
    expect(veh2?.data_status).toBe("RECEIVING");

    setSimulatorScenario("delivery_outage", true);

    const outageRes = await fetch(`${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/latest`, {
      headers: { Authorization: "Bearer demo_valid_token" },
    });
    expect(outageRes.status).toBe(503);

    vehicleRepository.updateStatus("veh_vlt_1", FLEET_ID, "STALE");
    const v1Stale = vehicleRepository.findById("veh_vlt_1", FLEET_ID);
    expect(v1Stale?.data_status).toBe("STALE");

    const stateDuringOutage = getDb().prepare("SELECT * FROM vehicle_current_state WHERE vehicle_id = 'veh_vlt_1'").get() as any;
    expect(stateDuringOutage.latest_values).toBe(stateV1_moved.latest_values);

    for (let i = 0; i < 3; i++) {
      engine.advancePhysics(3.0);
      engine.sampleTelemetry(true);
    }

    setSimulatorScenario("delivery_outage", false);

    const catchupRes = await fetch(
      `${VOLTERA_URL}/v1/vehicles/VLT-001/telemetry/history?cursor=${sample2_v1.sample_seq}&limit=10`,
      { headers: { Authorization: "Bearer demo_valid_token" } }
    );
    expect(catchupRes.status).toBe(200);
    const catchupData = (await catchupRes.json()) as any;
    expect(catchupData.events.length).toBeGreaterThanOrEqual(3);

    for (const evt of catchupData.events) {
      ingestEvent(FLEET_ID, conn.id, "VLT-001", evt.payload, evt.event_id, true);
    }
    drainWorker();

    vehicleRepository.updateStatus("veh_vlt_1", FLEET_ID, "RECEIVING");
    const v1Recovered = vehicleRepository.findById("veh_vlt_1", FLEET_ID);
    expect(v1Recovered?.data_status).toBe("RECEIVING");

    setSimulatorScenario("breaking_schema", true);
    engine.sampleTelemetry(true);

    const brokenSample = simDb
      .prepare("SELECT * FROM sim_samples WHERE oem_id = 'oem_voltera' AND vehicle_id = 'VLT-001' ORDER BY sample_seq DESC LIMIT 1")
      .get() as any;
    const brokenPayload = JSON.parse(brokenSample.payload);
    expect(brokenPayload.telemetry_v3).toBeDefined();

    const brokenIngest = ingestEvent(FLEET_ID, conn.id, "VLT-001", brokenPayload, brokenSample.id, true);
    expect(brokenIngest.status).toBe("ACCEPTED");
    drainWorker();

    const rawQuarantined = getDb()
      .prepare("SELECT * FROM raw_events WHERE id = ?")
      .get(brokenIngest.eventId) as any;
    expect(rawQuarantined.processing_status).toBe("QUARANTINED");

    const incident = getDb()
      .prepare("SELECT * FROM quarantine_incidents WHERE fleet_id = ? AND oem_id = 'oem_voltera' AND status = 'UNRESOLVED'")
      .get(FLEET_ID) as any;
    expect(incident).toBeDefined();

    const formatId = `fmt_voltera_v3_e2e_${Date.now()}`;
    const profileId = `prof_voltera_v3_e2e_${Date.now()}`;
    const db = getDb();

    db.prepare(`
      INSERT INTO oem_format_versions (id, oem_id, event_type, format_version, expected_structure)
      VALUES (?, 'oem_voltera', 'telemetry', 'v3', ?)
    `).run(
      formatId,
      JSON.stringify({
        required_fields: [
          { path: "telemetry_v3.speed_kph", type: "number" },
          { path: "telemetry_v3.battery_percent", type: "number" },
          { path: "timestamp", type: "string", is_time: true },
        ],
      })
    );

    db.prepare(`
      INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status)
      VALUES (?, ?, '1.0', '1.0', 'ACTIVE')
    `).run(profileId, formatId);

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
      raw_event_ids: [rawQuarantined.id],
    });
    expect(replayRes.jobId).toBeDefined();

    drainWorker();

    const rawReprocessed = getDb()
      .prepare("SELECT * FROM raw_events WHERE id = ?")
      .get(rawQuarantined.id) as any;
    expect(rawReprocessed.processing_status).toBe("PROCESSED");

    const normalized = getDb()
      .prepare("SELECT * FROM normalized_events WHERE raw_event_id = ?")
      .get(rawQuarantined.id) as any;
    expect(normalized).toBeDefined();

    setSimulatorScenario("breaking_schema", false);

    const build1 = buildProjectionsForVehicle("veh_vlt_1");
    const tripsAfter1 = getDb()
      .prepare("SELECT id, trip_number, distance_km FROM trips WHERE vehicle_id = 'veh_vlt_1' AND projection_status = 'CURRENT'")
      .all() as any[];

    const build2 = buildProjectionsForVehicle("veh_vlt_1");
    const tripsAfter2 = getDb()
      .prepare("SELECT id, trip_number, distance_km FROM trips WHERE vehicle_id = 'veh_vlt_1' AND projection_status = 'CURRENT'")
      .all() as any[];

    expect(tripsAfter1.length).toBe(tripsAfter2.length);
    if (tripsAfter1.length > 0) {
      expect(tripsAfter1[0].id).toBe(tripsAfter2[0].id);
      expect(tripsAfter1[0].distance_km).toBe(tripsAfter2[0].distance_km);
    }

    const insights = recalculateFleetInsights(FLEET_ID);
    expect(insights).toBeDefined();
    expect(typeof insights.safety_attention).toBe("number");
    expect(typeof insights.service_needed).toBe("number");
    expect(typeof insights.charging_needed).toBe("number");
    expect(typeof insights.data_quality_issues).toBe("number");

    const summary = getFleetInsightsSummary(FLEET_ID);
    expect(summary.safety_attention).toBe(insights.safety_attention);
    expect(summary.service_needed).toBe(insights.service_needed);
  });
});
