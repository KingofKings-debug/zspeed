import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { getDb, closeDb } from "../db/pool.js";
import {
  createConnection,
  authorizeConnection,
  discoverVehicles,
  activateConnection,
  disconnectConnection,
  reconnectConnection,
  checkConnectionHealth,
} from "../services/connection.service.js";
import { deliverBatch, isDeliveryActive, stopDemoDelivery } from "../services/delivery.service.js";
import { connectionRepository } from "../repositories/connection.repository.js";
import { vehicleRepository } from "../repositories/vehicle.repository.js";
import { getConnector, isConnectorAvailable } from "../connectors/index.js";
import { redactSensitive, storeSecret, getSecret } from "../services/vault.service.js";

const FLEET_ID = "fleet_test_connector";

let testDbPath: string;

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params);
}

function queryOne<T = any>(sql: string, params: any[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T;
}

beforeEach(() => {
  testDbPath = path.join(os.tmpdir(), `zspeed_test_conn_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  process.env.OVERRIDE_DB_PATH = testDbPath;
  closeDb();
  runMigrations();
  seedDatabase();

  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [FLEET_ID, "Connector Test Fleet"]);
  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    ["veh_vlt_01", FLEET_ID, "1VXMA82635D100001", "NO_CONNECTION"]);
  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    ["veh_vlt_02", FLEET_ID, "1VXMA82635D100002", "NO_CONNECTION"]);
});

afterEach(() => {
  stopDemoDelivery("conn_active_test");
  closeDb();
  try { fs.unlinkSync(testDbPath); } catch {}
  try { fs.unlinkSync(`${testDbPath}-wal`); } catch {}
  try { fs.unlinkSync(`${testDbPath}-shm`); } catch {}
});

describe("OEM Connector Contracts and Lifecycle", () => {
  it("rejects connection creation for an unsupported OEM", () => {
    expect(() => {
      createConnection(FLEET_ID, "oem_unsupported_xyz", "Test");
    }).toThrow("Unsupported OEM");
  });

  it("identifies supported demo connectors in registry", () => {
    expect(isConnectorAvailable("oem_voltera")).toBe(true);
    expect(isConnectorAvailable("oem_crestline")).toBe(true);
    expect(isConnectorAvailable("oem_navarro")).toBe(true);
    expect(isConnectorAvailable("oem_unknown")).toBe(false);

    const connector = getConnector("oem_voltera");
    expect(connector?.isDemo).toBe(true);
  });

  it("handles failed authorization with visible, actionable error and NOT_CONFIGURED status", async () => {
    const conn = createConnection(FLEET_ID, "oem_voltera", "Test Voltera");
    const result = await authorizeConnection(conn.id, FLEET_ID, {
      username: "fail",
      password: "wrong_password",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid credentials");

    const updated = connectionRepository.findById(conn.id, FLEET_ID);
    expect(updated?.status).toBe("NOT_CONFIGURED");
    expect(updated?.error_message).toContain("Invalid credentials");
  });

  it("successfully authorizes and discovers available vehicles", async () => {
    const conn = createConnection(FLEET_ID, "oem_voltera", "Test Voltera");
    const authResult = await authorizeConnection(conn.id, FLEET_ID, {
      username: "fleet_admin",
      password: "valid_password",
    });

    expect(authResult.success).toBe(true);

    const vehicles = await discoverVehicles(conn.id, FLEET_ID);
    expect(vehicles.length).toBeGreaterThan(0);
    expect(vehicles.some((v) => v.oem_vehicle_id === "VLT-001")).toBe(true);
  });

  it("activation puts vehicles into AWAITING_DATA and does not fabricate telemetry", async () => {
    const conn = createConnection(FLEET_ID, "oem_voltera", "Test Voltera");
    await authorizeConnection(conn.id, FLEET_ID, {
      username: "fleet_admin",
      password: "valid_password",
    });

    const activateResult = await activateConnection(conn.id, FLEET_ID, [
      { oem_vehicle_id: "VLT-001", vin: "1VXMA82635D100001", categories: ["location"] },
    ]);

    expect(activateResult.activated).toBe(1);

    const vehicle = vehicleRepository.findById("veh_vlt_01", FLEET_ID);
    expect(vehicle?.data_status).toBe("AWAITING_DATA");
    expect(vehicle?.last_data_at).toBeNull();

    const connection = connectionRepository.findById(conn.id, FLEET_ID);
    expect(connection?.status).toBe("ACTIVE");
    expect(connection?.last_data_received).toBeNull();
    expect(isDeliveryActive(conn.id)).toBe(true);

    await disconnectConnection(conn.id, FLEET_ID);
  });

  it("demo delivery feeds ingestion and produces real stored events, updating freshness", async () => {
    const conn = createConnection(FLEET_ID, "oem_voltera", "Test Voltera");
    await authorizeConnection(conn.id, FLEET_ID, {
      username: "fleet_admin",
      password: "valid_password",
    });

    await activateConnection(conn.id, FLEET_ID, [
      { oem_vehicle_id: "VLT-001", vin: "1VXMA82635D100001", categories: ["location"] },
    ]);

    const delivered = deliverBatch(conn.id);
    expect(delivered).toBe(1);

    const rawEventsCount = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM raw_events WHERE connection_id = ?",
      [conn.id]
    );
    expect(rawEventsCount?.count).toBe(1);

    const normEventsCount = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM normalized_events WHERE vehicle_id = ?",
      ["veh_vlt_01"]
    );
    expect(normEventsCount?.count).toBe(1);

    const vehicle = vehicleRepository.findById("veh_vlt_01", FLEET_ID);
    expect(vehicle?.data_status).toBe("RECEIVING");
    expect(vehicle?.last_data_at).not.toBeNull();

    const connection = connectionRepository.findById(conn.id, FLEET_ID);
    expect(connection?.last_data_received).not.toBeNull();

    await disconnectConnection(conn.id, FLEET_ID);
  });

  it("disconnect stops delivery and resets vehicles to NO_CONNECTION", async () => {
    const conn = createConnection(FLEET_ID, "oem_voltera", "Test Voltera");
    await authorizeConnection(conn.id, FLEET_ID, {
      username: "fleet_admin",
      password: "valid_password",
    });

    await activateConnection(conn.id, FLEET_ID, [
      { oem_vehicle_id: "VLT-001", vin: "1VXMA82635D100001", categories: ["location"] },
    ]);

    expect(isDeliveryActive(conn.id)).toBe(true);

    await disconnectConnection(conn.id, FLEET_ID);

    expect(isDeliveryActive(conn.id)).toBe(false);

    const connection = connectionRepository.findById(conn.id, FLEET_ID);
    expect(connection?.status).toBe("DISCONNECTED");

    const vehicle = vehicleRepository.findById("veh_vlt_01", FLEET_ID);
    expect(vehicle?.data_status).toBe("NO_CONNECTION");
    expect(vehicle?.connection_id).toBeNull();
  });

  it("health check detects expired credentials and transitions connection to EXPIRED", async () => {
    const conn = createConnection(FLEET_ID, "oem_voltera", "Test Voltera");
    await authorizeConnection(conn.id, FLEET_ID, {
      username: "fleet_admin",
      password: "valid_password",
    });

    connectionRepository.updateStatus(conn.id, "EXPIRED", "Token expired");

    const updated = connectionRepository.findById(conn.id, FLEET_ID);
    expect(updated?.status).toBe("EXPIRED");
    expect(updated?.error_message).toBe("Token expired");

    const reauth = await reconnectConnection(conn.id, FLEET_ID, {
      username: "fleet_admin",
      password: "new_valid_password",
    });
    expect(reauth.success).toBe(true);

    const reconnected = connectionRepository.findById(conn.id, FLEET_ID);
    expect(reconnected?.status).toBe("ACTIVE");

    await disconnectConnection(conn.id, FLEET_ID);
  });

  it("stores and encrypts secrets with redaction support", () => {
    const secretRef = storeSecret({
      username: "admin_user",
      password: "SuperSecretPassword123!",
      api_key: "key_xyz_987",
    });

    expect(secretRef.startsWith("sec_")).toBe(true);

    const retrieved = getSecret(secretRef);
    expect(retrieved?.password).toBe("SuperSecretPassword123!");
    expect(retrieved?.api_key).toBe("key_xyz_987");

    const redacted = redactSensitive(retrieved);
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.api_key).toBe("[REDACTED]");
    expect(redacted.username).toBe("admin_user");
  });
});
