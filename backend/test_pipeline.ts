import { ingestEvent, replayEvents } from "./src/services/ingestion.service.js";
import { query, queryOne } from "./src/db/pool.js";
import { runMigrations } from "./src/db/migrate.js";
import { seedDatabase } from "./src/db/seed.js";
import { v4 as uuid } from "uuid";
import assert from "assert";
import fs from "fs";

async function runTests() {
  console.log("Setting up test database...");
  if (fs.existsSync("../data/zspeed.db")) {
    fs.unlinkSync("../data/zspeed.db");
  }
  
  runMigrations();
  seedDatabase();

  const fleetId = "fleet-123";
  const connectionId = "conn-voltera-test";
  const vehicleId = "veh-voltera-test";
  
  query("INSERT INTO fleets (id, name) VALUES (?, ?)", [fleetId, "Test Fleet"]);
  query(
    "INSERT INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [connectionId, fleetId, "oem_voltera", "Test Connection", "ACTIVE"]
  );
  query(
    "INSERT INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [vehicleId, fleetId, "TESTVIN123", "NO_CONNECTION"]
  );
  query(
    "INSERT INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id) VALUES (?, ?, ?, ?)",
    [uuid(), vehicleId, connectionId, "oem-veh-1"]
  );

  console.log("\\n--- Test 1: Successful v1 Event Ingestion ---");
  const payloadV1 = { speed_mph: 60, charge_fraction: 0.9, odo_miles: 10000, status: "running" };
  const res1 = ingestEvent(fleetId, connectionId, "oem-veh-1", payloadV1, "evt-1");
  assert(res1.status === "PROCESSED", "v1 event should be processed");
  
  const state1 = queryOne("SELECT latest_values FROM vehicle_current_state WHERE vehicle_id = ?", [vehicleId]);
  const parsed1 = JSON.parse(state1.latest_values);
  assert(Math.abs(parsed1.vehicle_speed - 96.56) < 0.1, "Speed should be converted to km/h");
  assert(parsed1.battery_soc === 90, "Charge fraction should be converted to percent");
  assert(parsed1.ignition_status === "ON", "Status should be mapped to ON");
  console.log("Passed.");

  console.log("\\n--- Test 2: Idempotency (Exact Duplicate) ---");
  const res2 = ingestEvent(fleetId, connectionId, "oem-veh-1", payloadV1, "evt-1");
  assert(res2.status === "DUPLICATE", "Exact duplicate should be rejected");
  const countRaw = queryOne("SELECT COUNT(*) as c FROM raw_events WHERE source_event_id = 'evt-1'").c;
  assert(countRaw === 1, "Should only have 1 raw event stored");
  console.log("Passed.");

  console.log("\\n--- Test 3: Idempotency (Conflict / Source Revision) ---");
  const payloadV1Conflict = { speed_mph: 65, charge_fraction: 0.9, odo_miles: 10000, status: "running" };
  const res3 = ingestEvent(fleetId, connectionId, "oem-veh-1", payloadV1Conflict, "evt-1");
  assert(res3.status === "PROCESSED", "Conflict should be processed as revision");
  const countRawConflict = queryOne("SELECT COUNT(*) as c FROM raw_events WHERE source_event_id = 'evt-1'").c;
  assert(countRawConflict === 2, "Should have 2 raw events stored for the same source_event_id");
  console.log("Passed.");

  console.log("\\n--- Test 4: Quarantine Unknown Format (v2 Event) ---");
  const payloadV2 = { 
    data: { speed_mph: 70, charge_fraction: 0.8 }, 
    metadata: { odo_miles: 11000, status: "stopped" } 
  };
  const res4 = ingestEvent(fleetId, connectionId, "oem-veh-1", payloadV2, "evt-v2-1");
  assert(res4.status === "QUARANTINED", "v2 event with no active mapping should be quarantined");
  console.log("Passed.");

  console.log("\\n--- Test 5: Replay Job ---");
  // Create mapping profile for v2
  const oemFormatV2 = queryOne("SELECT id FROM oem_format_versions WHERE oem_id = 'oem_voltera' AND format_version = 'v2'");
  const v2ProfileId = uuid();
  query(
    "INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status) VALUES (?, ?, ?, ?, ?)",
    [v2ProfileId, oemFormatV2.id, "1.0", "1.0", "ACTIVE"]
  );
  const rules = [
    { id: uuid(), prof_id: v2ProfileId, path: "data.speed_mph", sig: "sig_speed", conv: "MPH_TO_KMH", enum_map: null },
    { id: uuid(), prof_id: v2ProfileId, path: "data.charge_fraction", sig: "sig_soc", conv: "FRACTION_TO_PERCENT", enum_map: null },
    { id: uuid(), prof_id: v2ProfileId, path: "metadata.odo_miles", sig: "sig_odometer", conv: "MILES_TO_KM", enum_map: null },
    { id: uuid(), prof_id: v2ProfileId, path: "metadata.status", sig: "sig_ignition", conv: "ENUM_MAP", enum_map: JSON.stringify({ "running": "ON", "stopped": "OFF" }) },
  ];
  for (const r of rules) {
    query(
      "INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type, enum_mapping) VALUES (?, ?, ?, ?, ?, ?)",
      [r.id, r.prof_id, r.path, r.sig, r.conv, r.enum_map]
    );
  }

  // Trigger Replay
  replayEvents(v2ProfileId);
  // Wait for replay to complete asynchronously
  await new Promise((resolve) => setTimeout(resolve, 500));
  
  const v2EventStatus = queryOne("SELECT processing_status FROM raw_events WHERE id = ?", [res4.eventId]).processing_status;
  assert(v2EventStatus === "PROCESSED", "v2 event should be processed after replay");
  
  const stateReplayed = queryOne("SELECT latest_values FROM vehicle_current_state WHERE vehicle_id = ?", [vehicleId]);
  const parsedReplayed = JSON.parse(stateReplayed.latest_values);
  assert(Math.abs(parsedReplayed.vehicle_speed - 112.65) < 0.1, "Replayed speed should be correct");
  assert(parsedReplayed.battery_soc === 80, "Replayed soc should be correct");
  assert(parsedReplayed.ignition_status === "OFF", "Replayed status should be correct");
  
  console.log("Passed.");

  console.log("\\nAll tests passed successfully!");
}

runTests().catch(console.error);
