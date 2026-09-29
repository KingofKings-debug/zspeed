import { run, queryOne } from "./pool.js";
import { config } from "../config.js";
import { v4 as uuid } from "uuid";

export function seedDatabase(): void {
  console.log("Seeding database...");

  const fleetCheck = queryOne<{ id: string }>(
    "SELECT id FROM fleets WHERE id = ?",
    [config.defaultFleetId]
  );

  if (!fleetCheck) {
    run("INSERT INTO fleets (id, name) VALUES (?, ?)", [
      config.defaultFleetId,
      "Demo Fleet Operations",
    ]);

    const oems = [
      {
        id: "oem_voltera",
        name: "Voltera Motors",
        code: "VOLTERA",
        supported_categories: JSON.stringify(["location", "fuel_level", "odometer", "engine_status", "tire_pressure", "battery_voltage"]),
        auth_type: "oauth_simulated",
      },
      {
        id: "oem_crestline",
        name: "Crestline Automotive",
        code: "CRESTLINE",
        supported_categories: JSON.stringify(["location", "odometer", "engine_status", "diagnostics", "door_status"]),
        auth_type: "api_key_simulated",
      },
      {
        id: "oem_navarro",
        name: "Navarro Commercial Vehicles",
        code: "NAVARRO",
        supported_categories: JSON.stringify(["location", "fuel_level", "odometer", "cargo_weight", "temperature_zone", "driver_hours"]),
        auth_type: "oauth_simulated",
      },
    ];

    for (const oem of oems) {
      run(
        "INSERT INTO supported_oems (id, name, code, supported_categories, auth_type) VALUES (?, ?, ?, ?, ?)",
        [oem.id, oem.name, oem.code, oem.supported_categories, oem.auth_type]
      );
    }

    const vehicles = [
      { vin: "1VXMA82635D100001", label: "Fleet Van 01", manufacturer: "Voltera Motors", oem_id: "oem_voltera" },
      { vin: "1VXMA82635D100002", label: "Fleet Van 02", manufacturer: "Voltera Motors", oem_id: "oem_voltera" },
      { vin: "1VXMA82635D100003", label: "Fleet Van 03", manufacturer: "Voltera Motors", oem_id: "oem_voltera" },
      { vin: "2CRST96748E200001", label: "Sedan A-1", manufacturer: "Crestline Automotive", oem_id: "oem_crestline" },
      { vin: "2CRST96748E200002", label: "Sedan A-2", manufacturer: "Crestline Automotive", oem_id: "oem_crestline" },
      { vin: "3NAVR11859F300001", label: "Truck H-1", manufacturer: "Navarro Commercial Vehicles", oem_id: "oem_navarro" },
      { vin: "3NAVR11859F300002", label: "Truck H-2", manufacturer: "Navarro Commercial Vehicles", oem_id: "oem_navarro" },
      { vin: "3NAVR11859F300003", label: "Truck H-3", manufacturer: "Navarro Commercial Vehicles", oem_id: "oem_navarro" },
    ];

    for (const v of vehicles) {
      run(
        `INSERT INTO vehicles (id, fleet_id, vin, label, suggested_manufacturer, oem_id, data_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), config.defaultFleetId, v.vin, v.label, v.manufacturer, v.oem_id, "NO_CONNECTION"]
      );
    }
  }

  const pipelineCheck = queryOne<{ id: string }>(
    "SELECT id FROM canonical_signals WHERE id = ?",
    ["sig_speed"]
  );

  if (pipelineCheck) {
    console.log("Pipeline seed data already exists, checking GPS signals...");
    const gpsCheck = queryOne<{ id: string }>(
      "SELECT id FROM canonical_signals WHERE id = ?",
      ["sig_latitude"]
    );
    if (!gpsCheck) {
      seedGpsSignalsAndMappings();
    }
    console.log("Seed complete.");
    return;
  }

  const canonicalSignals = [
    { id: "sig_speed", name: "vehicle_speed", data_type: "NUMBER", unit: "km/h", description: "Vehicle speed in km/h", valid_range_min: 0, valid_range_max: 300, missing_value_policy: "IGNORE" },
    { id: "sig_soc", name: "battery_soc", data_type: "NUMBER", unit: "%", description: "Battery State of Charge (%)", valid_range_min: 0, valid_range_max: 100, missing_value_policy: "IGNORE" },
    { id: "sig_odometer", name: "odometer", data_type: "NUMBER", unit: "km", description: "Total distance traveled", valid_range_min: 0, valid_range_max: 2000000, missing_value_policy: "IGNORE" },
    { id: "sig_ignition", name: "ignition_status", data_type: "STRING", unit: null, description: "Ignition status (ON/OFF)", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
    { id: "sig_latitude", name: "latitude", data_type: "NUMBER", unit: "deg", description: "GPS latitude in decimal degrees", valid_range_min: -90, valid_range_max: 90, missing_value_policy: "IGNORE" },
    { id: "sig_longitude", name: "longitude", data_type: "NUMBER", unit: "deg", description: "GPS longitude in decimal degrees", valid_range_min: -180, valid_range_max: 180, missing_value_policy: "IGNORE" },
    { id: "sig_altitude", name: "altitude", data_type: "NUMBER", unit: "m", description: "Altitude in metres above sea level", valid_range_min: -500, valid_range_max: 9000, missing_value_policy: "IGNORE" },
    { id: "sig_heading", name: "heading", data_type: "NUMBER", unit: "deg", description: "GPS heading in degrees (0=North)", valid_range_min: 0, valid_range_max: 360, missing_value_policy: "IGNORE" },
    { id: "sig_gps_accuracy", name: "gps_accuracy_m", data_type: "NUMBER", unit: "m", description: "GPS horizontal accuracy in metres", valid_range_min: 0, valid_range_max: 500, missing_value_policy: "IGNORE" },
    { id: "sig_harsh_brake", name: "harsh_brake", data_type: "STRING", unit: null, description: "Harsh braking event flag (YES/NO)", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
    { id: "sig_idle_state", name: "idle_state", data_type: "STRING", unit: null, description: "Vehicle idle state (IDLE/MOVING)", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
    { id: "sig_charging", name: "charging_state", data_type: "STRING", unit: null, description: "EV charging state (CHARGING/NOT_CHARGING)", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
    { id: "sig_fault_code", name: "fault_code", data_type: "STRING", unit: null, description: "Active OBD or OEM fault code", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
    { id: "sig_event_time", name: "event_time", data_type: "STRING", unit: null, description: "ISO-8601 timestamp of the originating event", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
  ];

  for (const sig of canonicalSignals) {
    run(
      `INSERT INTO canonical_signals (id, name, data_type, unit, description, valid_range_min, valid_range_max, missing_value_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sig.id, sig.name, sig.data_type, sig.unit, sig.description, sig.valid_range_min, sig.valid_range_max, sig.missing_value_policy]
    );
  }

  const volteraV1Id = "fmt_voltera_telemetry_v1";
  const volteraV2Id = "fmt_voltera_telemetry_v2";
  const crestlineV1Id = "fmt_crestline_telemetry_v1";

  run(
    `INSERT INTO oem_format_versions (id, oem_id, event_type, format_version, expected_structure) VALUES (?, ?, ?, ?, ?)`,
    [volteraV1Id, "oem_voltera", "telemetry", "v1", JSON.stringify({
      speed_mph: "number", charge_fraction: "number", odo_miles: "number", status: "string",
      lat: "number", lon: "number", heading: "number", altitude: "number",
      harsh_brake: "boolean", fault_code: "string", timestamp: "string"
    })]
  );
  run(
    `INSERT INTO oem_format_versions (id, oem_id, event_type, format_version, expected_structure) VALUES (?, ?, ?, ?, ?)`,
    [volteraV2Id, "oem_voltera", "telemetry", "v2", JSON.stringify({
      data: { speed_mph: "number", charge_fraction: "number", lat: "number", lon: "number" },
      metadata: { odo_miles: "number", status: "string", fault_code: "string", timestamp: "string" }
    })]
  );
  run(
    `INSERT INTO oem_format_versions (id, oem_id, event_type, format_version, expected_structure) VALUES (?, ?, ?, ?, ?)`,
    [crestlineV1Id, "oem_crestline", "telemetry", "v1", JSON.stringify({
      velocity_kmh: "number", battery_pct: "number", distance_km: "number", ignition: "boolean",
      gps_lat: "number", gps_lon: "number", gps_heading: "number",
      harsh_braking: "boolean", charging: "boolean", fault: "string",
      "state.velocity_kmh": "number", "state.distance_km": "number", "state.ignition": "boolean",
      "state.battery_pct": "number", time_measured: "number"
    })]
  );

  const volteraV1ProfId = "prof_voltera_v1";
  const crestlineV1ProfId = "prof_crestline_v1";

  run(
    `INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status) VALUES (?, ?, ?, ?, ?)`,
    [volteraV1ProfId, volteraV1Id, "1.0", "1.0", "ACTIVE"]
  );
  run(
    `INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status) VALUES (?, ?, ?, ?, ?)`,
    [crestlineV1ProfId, crestlineV1Id, "1.0", "1.0", "ACTIVE"]
  );

  const rules = [
    { id: uuid(), prof_id: volteraV1ProfId, path: "speed_mph", sig: "sig_speed", conv: "MPH_TO_KMH", enum_map: null },
    { id: uuid(), prof_id: volteraV1ProfId, path: "charge_fraction", sig: "sig_soc", conv: "FRACTION_TO_PERCENT", enum_map: null },
    { id: uuid(), prof_id: volteraV1ProfId, path: "odo_miles", sig: "sig_odometer", conv: "MILES_TO_KM", enum_map: null },
    { id: uuid(), prof_id: volteraV1ProfId, path: "status", sig: "sig_ignition", conv: "ENUM_MAP", enum_map: JSON.stringify({ "running": "ON", "stopped": "OFF" }) },
    { id: uuid(), prof_id: volteraV1ProfId, path: "lat", sig: "sig_latitude", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: volteraV1ProfId, path: "lon", sig: "sig_longitude", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: volteraV1ProfId, path: "altitude", sig: "sig_altitude", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: volteraV1ProfId, path: "heading", sig: "sig_heading", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: volteraV1ProfId, path: "harsh_brake", sig: "sig_harsh_brake", conv: "ENUM_MAP", enum_map: JSON.stringify({ "true": "YES", "false": "NO" }) },
    { id: uuid(), prof_id: volteraV1ProfId, path: "fault_code", sig: "sig_fault_code", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: volteraV1ProfId, path: "timestamp", sig: "sig_event_time", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: crestlineV1ProfId, path: "state.velocity_kmh", sig: "sig_speed", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: crestlineV1ProfId, path: "state.battery_pct", sig: "sig_soc", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: crestlineV1ProfId, path: "state.distance_km", sig: "sig_odometer", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: crestlineV1ProfId, path: "state.ignition", sig: "sig_ignition", conv: "ENUM_MAP", enum_map: JSON.stringify({ "true": "ON", "false": "OFF" }) },
    { id: uuid(), prof_id: crestlineV1ProfId, path: "state.gps_lat", sig: "sig_latitude", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: crestlineV1ProfId, path: "state.gps_lon", sig: "sig_longitude", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: crestlineV1ProfId, path: "state.gps_heading", sig: "sig_heading", conv: "DIRECT", enum_map: null },
    { id: uuid(), prof_id: crestlineV1ProfId, path: "state.harsh_braking", sig: "sig_harsh_brake", conv: "ENUM_MAP", enum_map: JSON.stringify({ "true": "YES", "false": "NO" }) },
    { id: uuid(), prof_id: crestlineV1ProfId, path: "state.charging", sig: "sig_charging", conv: "ENUM_MAP", enum_map: JSON.stringify({ "true": "CHARGING", "false": "NOT_CHARGING" }) },
    { id: uuid(), prof_id: crestlineV1ProfId, path: "state.fault", sig: "sig_fault_code", conv: "DIRECT", enum_map: null },
  ];

  for (const r of rules) {
    run(
      `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type, enum_mapping) VALUES (?, ?, ?, ?, ?, ?)`,
      [r.id, r.prof_id, r.path, r.sig, r.conv, r.enum_map]
    );
  }

  console.log("Seed data inserted successfully.");
}

function seedGpsSignalsAndMappings(): void {
  const gpsSignals = [
    { id: "sig_latitude", name: "latitude", data_type: "NUMBER", unit: "deg", description: "GPS latitude in decimal degrees", valid_range_min: -90, valid_range_max: 90, missing_value_policy: "IGNORE" },
    { id: "sig_longitude", name: "longitude", data_type: "NUMBER", unit: "deg", description: "GPS longitude in decimal degrees", valid_range_min: -180, valid_range_max: 180, missing_value_policy: "IGNORE" },
    { id: "sig_altitude", name: "altitude", data_type: "NUMBER", unit: "m", description: "Altitude in metres above sea level", valid_range_min: -500, valid_range_max: 9000, missing_value_policy: "IGNORE" },
    { id: "sig_heading", name: "heading", data_type: "NUMBER", unit: "deg", description: "GPS heading in degrees (0=North)", valid_range_min: 0, valid_range_max: 360, missing_value_policy: "IGNORE" },
    { id: "sig_gps_accuracy", name: "gps_accuracy_m", data_type: "NUMBER", unit: "m", description: "GPS horizontal accuracy in metres", valid_range_min: 0, valid_range_max: 500, missing_value_policy: "IGNORE" },
    { id: "sig_harsh_brake", name: "harsh_brake", data_type: "STRING", unit: null, description: "Harsh braking event flag (YES/NO)", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
    { id: "sig_idle_state", name: "idle_state", data_type: "STRING", unit: null, description: "Vehicle idle state (IDLE/MOVING)", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
    { id: "sig_charging", name: "charging_state", data_type: "STRING", unit: null, description: "EV charging state (CHARGING/NOT_CHARGING)", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
    { id: "sig_fault_code", name: "fault_code", data_type: "STRING", unit: null, description: "Active OBD or OEM fault code", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
    { id: "sig_event_time", name: "event_time", data_type: "STRING", unit: null, description: "ISO-8601 timestamp of the originating event", valid_range_min: null, valid_range_max: null, missing_value_policy: "IGNORE" },
  ];

  for (const sig of gpsSignals) {
    const existing = queryOne("SELECT id FROM canonical_signals WHERE id = ?", [sig.id]);
    if (!existing) {
      run(
        `INSERT INTO canonical_signals (id, name, data_type, unit, description, valid_range_min, valid_range_max, missing_value_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sig.id, sig.name, sig.data_type, sig.unit, sig.description, sig.valid_range_min, sig.valid_range_max, sig.missing_value_policy]
      );
    }
  }

  const volteraV1ProfId = "prof_voltera_v1";
  const crestlineV1ProfId = "prof_crestline_v1";

  const gpsRules = [
    { prof_id: volteraV1ProfId, path: "lat", sig: "sig_latitude", conv: "DIRECT" },
    { prof_id: volteraV1ProfId, path: "lon", sig: "sig_longitude", conv: "DIRECT" },
    { prof_id: volteraV1ProfId, path: "altitude", sig: "sig_altitude", conv: "DIRECT" },
    { prof_id: volteraV1ProfId, path: "heading", sig: "sig_heading", conv: "DIRECT" },
    { prof_id: volteraV1ProfId, path: "harsh_brake", sig: "sig_harsh_brake", conv: "ENUM_MAP", enum_map: JSON.stringify({ "true": "YES", "false": "NO" }) },
    { prof_id: volteraV1ProfId, path: "fault_code", sig: "sig_fault_code", conv: "DIRECT" },
    { prof_id: volteraV1ProfId, path: "timestamp", sig: "sig_event_time", conv: "DIRECT" },
    { prof_id: crestlineV1ProfId, path: "state.gps_lat", sig: "sig_latitude", conv: "DIRECT" },
    { prof_id: crestlineV1ProfId, path: "state.gps_lon", sig: "sig_longitude", conv: "DIRECT" },
    { prof_id: crestlineV1ProfId, path: "state.gps_heading", sig: "sig_heading", conv: "DIRECT" },
    { prof_id: crestlineV1ProfId, path: "state.harsh_braking", sig: "sig_harsh_brake", conv: "ENUM_MAP", enum_map: JSON.stringify({ "true": "YES", "false": "NO" }) },
    { prof_id: crestlineV1ProfId, path: "state.charging", sig: "sig_charging", conv: "ENUM_MAP", enum_map: JSON.stringify({ "true": "CHARGING", "false": "NOT_CHARGING" }) },
    { prof_id: crestlineV1ProfId, path: "state.fault", sig: "sig_fault_code", conv: "DIRECT" },
  ];

  for (const r of gpsRules) {
    const exists = queryOne(
      "SELECT id FROM mapping_rules WHERE mapping_profile_id = ? AND source_field_path = ?",
      [r.prof_id, r.path]
    );
    if (!exists) {
      run(
        `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type, enum_mapping) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuid(), r.prof_id, r.path, r.sig, r.conv, (r as any).enum_map || null]
      );
    }
  }

  console.log("GPS signals and mapping rules added.");
}
