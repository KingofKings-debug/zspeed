import { PRNG } from "./prng.js";
import { config } from "../config.js";
import {
  generateVolteraV1Trip,
  generateCrestlineV1Trip,
  generateVolteraV2BreakingPayload,
  generateIdlePeriod,
  type SimulatedEvent,
} from "./oems.js";
import fs from "fs";
import { ingestEvent } from "../services/ingestion.service.js";
import { drainWorker } from "../services/worker.service.js";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { query, run, queryOne } from "../db/pool.js";
import { v4 as uuid } from "uuid";

interface SimulatorConfig {
  seed: number;
  mode: "fixture" | "load";
  fleetId: string;
  durationMinutes: number;
}

interface ManifestEntry {
  scenario: string;
  expectedStatus: string;
  vehicleId?: string;
  tripIndex?: number;
}

export async function runSimulator(cfg: SimulatorConfig) {
  const prng = new PRNG(cfg.seed);
  const manifest: ManifestEntry[] = [];

  const connA = "conn_oem_a";
  const connB = "conn_oem_b";

  const vehA1 = "sim_veh_a1";
  const vehA2 = "sim_veh_a2";
  const vehB1 = "sim_veh_b1";

  runMigrations();
  seedDatabase();

  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [cfg.fleetId, "Simulator Fleet"]);
  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [connA, cfg.fleetId, "oem_voltera", "Sim Conn A", "ACTIVE"]);
  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [connB, cfg.fleetId, "oem_crestline", "Sim Conn B", "ACTIVE"]);

  const setupVehicle = (vehId: string, connId: string, vin: string) => {
    run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
      [vehId, cfg.fleetId, vin, "NO_CONNECTION"]);
    const existing = queryOne(
      "SELECT id FROM vehicle_source_mappings WHERE vehicle_id = ? AND connection_id = ?",
      [vehId, connId]
    );
    if (!existing) {
      run("INSERT INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id) VALUES (?, ?, ?, ?)",
        [uuid(), vehId, connId, vehId]);
    }
  };

  setupVehicle(vehA1, connA, `SIMVIN${vehA1.toUpperCase()}`);
  setupVehicle(vehA2, connA, `SIMVIN${vehA2.toUpperCase()}`);
  setupVehicle(vehB1, connB, `SIMVIN${vehB1.toUpperCase()}`);

  let baseTime = new Date("2026-09-01T07:00:00Z");

  const ingestBatch = (
    events: SimulatedEvent[],
    connId: string,
    expectedStatus: string,
    scenario: string,
    vehicleId?: string,
    tripIndex?: number
  ) => {
    for (const e of events) {
      const res = ingestEvent(cfg.fleetId, connId, e.source_vehicle_id, e.payload, e.source_event_id);
      manifest.push({ scenario, expectedStatus, vehicleId, tripIndex });
      if (cfg.mode === "fixture" && res.status !== expectedStatus) {
        console.warn(`[SIM] Mismatch scenario=${scenario} expected=${expectedStatus} got=${res.status}: ${res.message}`);
      }
    }
  };

  console.log("[SIM] Phase 1: Normal trips for all vehicles...");

  for (let tripIdx = 0; tripIdx < 3; tripIdx++) {
    const t = new Date(baseTime.getTime() + tripIdx * 3 * 60 * 60 * 1000);

    const tripA1 = generateVolteraV1Trip(prng, vehA1, t, tripIdx, true, tripIdx === 1 ? 5 : -1, -1, -1);
    ingestBatch(tripA1, connA, "PROCESSED", `veh_a1_trip_${tripIdx}`, vehA1, tripIdx);

    const idleA1 = generateIdlePeriod(prng, vehA1, new Date(t.getTime() + 60 * 60000), 20);
    ingestBatch(idleA1, connA, "PROCESSED", `veh_a1_idle_${tripIdx}`, vehA1);

    const tripB1 = generateCrestlineV1Trip(prng, vehB1, t, tripIdx);
    ingestBatch(tripB1, connB, "PROCESSED", `veh_b1_trip_${tripIdx}`, vehB1, tripIdx);
  }

  console.log("[SIM] Phase 2: GPS gap trip for veh_a1...");
  const gapTripTime = new Date(baseTime.getTime() + 10 * 60 * 60 * 1000);
  const tripWithGap = generateVolteraV1Trip(prng, vehA1, gapTripTime, 0, true, -1, -1, 3);
  ingestBatch(tripWithGap, connA, "PROCESSED", "veh_a1_trip_with_gap", vehA1);

  console.log("[SIM] Phase 3: Trip with fault for veh_a1...");
  const faultTripTime = new Date(baseTime.getTime() + 12 * 60 * 60 * 1000);
  const tripWithFault = generateVolteraV1Trip(prng, vehA1, faultTripTime, 1, true, 4, 7, -1);
  ingestBatch(tripWithFault, connA, "PROCESSED", "veh_a1_trip_with_fault", vehA1);

  console.log("[SIM] Phase 4: Duplicate events...");
  const dupTime = new Date(baseTime.getTime() + 13 * 60 * 60 * 1000);
  const dupTrip = generateVolteraV1Trip(prng, vehA1, dupTime, 0, false);
  ingestBatch(dupTrip.slice(0, 1), connA, "PROCESSED", "original_event", vehA1);
  ingestBatch(dupTrip.slice(0, 1), connA, "DUPLICATE", "duplicate_event", vehA1);

  console.log("[SIM] Phase 5: Out-of-order delayed batch...");
  const delayedTime = new Date(baseTime.getTime() + 14 * 60 * 60 * 1000);
  const delayedTrip = generateVolteraV1Trip(prng, vehB1, delayedTime, 2, true);
  const shuffled = [...delayedTrip].reverse();
  ingestBatch(shuffled, connA, "QUARANTINED", "out_of_order_batch_wrong_conn", vehB1);

  console.log("[SIM] Phase 6: Implausible sensor value...");
  const badTime = new Date(baseTime.getTime() + 15 * 60 * 60 * 1000);
  const badPayload = {
    timestamp: badTime.toISOString(),
    speed_mph: "sixty",
    charge_fraction: 0.5,
    odo_miles: 15500,
    status: "running",
    lat: 51.508,
    lon: -0.127,
    altitude: 15,
    heading: 90,
    harsh_brake: false,
  };
  const badRes = ingestEvent(cfg.fleetId, connA, vehA1, badPayload, `bad_val_${Date.now()}`);
  manifest.push({ scenario: "invalid_sensor_value", expectedStatus: "QUARANTINED", vehicleId: vehA1 });

  console.log("[SIM] Phase 7: OEM format change (breaking) for veh_a2...");
  for (let i = 0; i < 10; i++) {
    const breakTime = new Date(baseTime.getTime() + (16 + i) * 60 * 60 * 1000);
    const breakPayload = generateVolteraV2BreakingPayload(prng, vehA2, breakTime);
    const res = ingestEvent(cfg.fleetId, connA, vehA2, breakPayload.payload, breakPayload.source_event_id);
    manifest.push({ scenario: "oem_format_change", expectedStatus: "QUARANTINED", vehicleId: vehA2 });
    if (cfg.mode === "fixture" && res.status !== "QUARANTINED") {
      console.warn(`[SIM] Expected QUARANTINED for format change, got ${res.status}: ${res.message}`);
    }
  }

  console.log("[SIM] Draining worker queue...");
  drainWorker();

  const stats = {
    total: manifest.length,
    processed: manifest.filter((m) => m.expectedStatus === "PROCESSED").length,
    quarantined: manifest.filter((m) => m.expectedStatus === "QUARANTINED").length,
    duplicate: manifest.filter((m) => m.expectedStatus === "DUPLICATE").length,
  };

  const trips = query("SELECT * FROM trips WHERE fleet_id = ?", [cfg.fleetId]);
  const incidents = query("SELECT * FROM quarantine_incidents WHERE fleet_id = ?", [cfg.fleetId]);

  const output = {
    config: cfg,
    stats,
    manifest,
    dbSummary: {
      trips: trips.length,
      quarantineIncidents: incidents.length,
    },
  };

  if (cfg.mode === "fixture") {
    fs.writeFileSync("simulator-manifest.json", JSON.stringify(output, null, 2));
    console.log(`[SIM] Fixture complete. ${manifest.length} events. Trips: ${trips.length}. Incidents: ${incidents.length}.`);
  } else {
    console.log(`[SIM] Load mode complete. ${manifest.length} events processed.`);
  }

  return output;
}

if (process.argv[1] && process.argv[1].includes("simulator")) {
  const mode = process.argv.includes("--load") ? "load" : "fixture";
  runSimulator({
    seed: 12345,
    mode: mode,
    fleetId: config.defaultFleetId,
    durationMinutes: mode === "load" ? 60 * 24 : 30,
  }).catch(console.error);
}
