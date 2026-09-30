import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import type { Server } from "http";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { getDb, closeDb } from "../db/pool.js";
import { httpServer } from "../index.js";
import { v4 as uuid } from "uuid";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import { signAuthToken } from "../middleware/fleet.js";
import { config } from "../config.js";

const FLEET_A = "fleet_tenant_a";
const FLEET_B = "fleet_tenant_b";
const CONN_A = "conn_tenant_a";
const CONN_B = "conn_tenant_b";
const VEH_A = "veh_tenant_a";
const VEH_B = "veh_tenant_b";
const TRIP_A = "trip_tenant_a";
const INCIDENT_A = "incident_tenant_a";

let testDbPath: string;
let server: Server;
let baseUrl: string;

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params);
}

function seedTwoFleets() {
  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [FLEET_A, "Alpha Fleet"]);
  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [FLEET_B, "Beta Fleet"]);

  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_A, FLEET_A, "oem_voltera", "Alpha Conn", "ACTIVE"]);
  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_B, FLEET_B, "oem_voltera", "Beta Conn", "ACTIVE"]);

  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [VEH_A, FLEET_A, "VIN_ALPHA_001", "AWAITING_DATA"]);
  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [VEH_B, FLEET_B, "VIN_BETA_001", "AWAITING_DATA"]);

  run("INSERT OR IGNORE INTO trips (id, vehicle_id, fleet_id, trip_number, started_at, ended_at, distance_km, duration_seconds, completeness_pct, projection_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [TRIP_A, VEH_A, FLEET_A, 1, "2026-09-01T10:00:00Z", "2026-09-01T11:00:00Z", 25.5, 3600, 100, "CURRENT"]);

  run("INSERT OR IGNORE INTO quarantine_incidents (id, fleet_id, oem_id, title, failure_category, first_failure_at, latest_at, status, affected_vehicle_count, unresolved_event_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [INCIDENT_A, FLEET_A, "oem_voltera", "Invalid schema", "INVALID_FORMAT", "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z", "UNRESOLVED", 1, 1]);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = httpServer.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  testDbPath = path.join(os.tmpdir(), `zspeed_tenant_iso_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  process.env.OVERRIDE_DB_PATH = testDbPath;
  closeDb();
  runMigrations();
  seedDatabase();
  seedTwoFleets();
});

afterEach(() => {
  closeDb();
  try { fs.unlinkSync(testDbPath); } catch {}
  try { fs.unlinkSync(`${testDbPath}-wal`); } catch {}
  try { fs.unlinkSync(`${testDbPath}-shm`); } catch {}
});

describe("Tenant Isolation and Auth", () => {
  it("defaults to demo fleet in demo mode without auth header", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.vehicles).toBeDefined();
  });

  it("authenticates correctly with demo token for Fleet B", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles`, {
      headers: {
        Authorization: `Bearer demo:${FLEET_B}:fleet_manager`,
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const vins = data.vehicles.map((v: any) => v.vin);
    expect(vins).toContain("VIN_BETA_001");
    expect(vins).not.toContain("VIN_ALPHA_001");
  });

  it("forged x-fleet-id header cannot override identity or access another fleet", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles`, {
      headers: {
        Authorization: `Bearer demo:${FLEET_B}:fleet_manager`,
        "x-fleet-id": FLEET_A,
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const vins = data.vehicles.map((v: any) => v.vin);
    expect(vins).not.toContain("VIN_ALPHA_001");
  });

  it("fleet B cannot view vehicle belonging to fleet A", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles/${VEH_A}`, {
      headers: {
        Authorization: `Bearer demo:${FLEET_B}:fleet_manager`,
      },
    });
    expect(res.status).toBe(404);
  });

  it("fleet B cannot view vehicle detail or trips belonging to fleet A", async () => {
    const resDetail = await fetch(`${baseUrl}/api/vehicles/${VEH_A}/detail`, {
      headers: {
        Authorization: `Bearer demo:${FLEET_B}:fleet_manager`,
      },
    });
    expect(resDetail.status).toBe(404);

    const resTrips = await fetch(`${baseUrl}/api/vehicles/${VEH_A}/trips`, {
      headers: {
        Authorization: `Bearer demo:${FLEET_B}:fleet_manager`,
      },
    });
    expect(resTrips.status).toBe(404);

    const resTripRoute = await fetch(`${baseUrl}/api/vehicles/${VEH_A}/trips/${TRIP_A}/route`, {
      headers: {
        Authorization: `Bearer demo:${FLEET_B}:fleet_manager`,
      },
    });
    expect(resTripRoute.status).toBe(404);
  });

  it("fleet B cannot trigger a projection rebuild for fleet A vehicle", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles/${VEH_A}/rebuild`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_B}:fleet_manager`,
      },
      body: JSON.stringify({ reason: "Unauthorized attempt" }),
    });
    expect(res.status).toBe(404);
  });

  it("fleet B cannot view or acknowledge fleet A quarantine incidents", async () => {
    const resView = await fetch(`${baseUrl}/api/quarantine/incidents/${INCIDENT_A}`, {
      headers: {
        Authorization: `Bearer demo:${FLEET_B}:fleet_manager`,
      },
    });
    expect(resView.status).toBe(404);

    const resAck = await fetch(`${baseUrl}/api/quarantine/incidents/${INCIDENT_A}/acknowledge`, {
      method: "POST",
      headers: {
        Authorization: `Bearer demo:${FLEET_B}:fleet_manager`,
      },
    });
    expect(resAck.status).toBe(404);
  });

  it("fleet B cannot ingest events against fleet A connection", async () => {
    const res = await fetch(`${baseUrl}/api/ingestion/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_B}:fleet_manager`,
      },
      body: JSON.stringify({
        connection_id: CONN_A,
        source_vehicle_id: "fake_id",
        payload: { test: true },
      }),
    });
    expect(res.status).toBe(404);
  });

  it("fleet manager cannot trigger replay or publish mappings without platform_admin role", async () => {
    const resPublish = await fetch(`${baseUrl}/api/ingestion/mappings/some-id/publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer demo:${FLEET_A}:fleet_manager`,
      },
    });
    expect(resPublish.status).toBe(403);

    const resReplay = await fetch(`${baseUrl}/api/ingestion/replay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_A}:fleet_manager`,
      },
      body: JSON.stringify({
        mapping_profile_id: "some_profile",
      }),
    });
    expect(resReplay.status).toBe(403);
  });

  it("platform admin can access replay endpoint", async () => {
    const profile = getDb().prepare("SELECT id FROM mapping_profiles LIMIT 1").get() as any;
    const resReplay = await fetch(`${baseUrl}/api/ingestion/replay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_A}:platform_admin`,
      },
      body: JSON.stringify({
        mapping_profile_id: profile?.id || "mp_voltera_v1",
        incident_id: INCIDENT_A,
      }),
    });
    expect(resReplay.status).not.toBe(403);
    expect(resReplay.status).toBe(200);
  });

  it("verifies server-signed token and derives fleet and role across HTTP and sockets", async () => {
    const validToken = signAuthToken({
      userId: "user_alpha_mgr",
      fleetId: FLEET_A,
      role: "fleet_manager",
    });

    const res = await fetch(`${baseUrl}/api/vehicles`, {
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const vins = data.vehicles.map((v: any) => v.vin);
    expect(vins).toContain("VIN_ALPHA_001");
    expect(vins).not.toContain("VIN_BETA_001");

    const client: ClientSocket = Client(baseUrl, {
      auth: { token: validToken },
      transports: ["websocket", "polling"],
    });

    const connectData = await new Promise<any>((resolve) => {
      client.on("connected", (d) => resolve(d));
    });
    expect(connectData.fleetId).toBe(FLEET_A);
    client.close();
  });

  it("rejects forged and tampered tokens", async () => {
    const validToken = signAuthToken({
      userId: "user_alpha_mgr",
      fleetId: FLEET_A,
      role: "fleet_manager",
    });

    const forgedToken = validToken.slice(0, -6) + "000000";

    const resHttp = await fetch(`${baseUrl}/api/vehicles`, {
      headers: {
        Authorization: `Bearer ${forgedToken}`,
      },
    });
    expect(resHttp.status).toBe(401);

    const client: ClientSocket = Client(baseUrl, {
      auth: { token: forgedToken },
      transports: ["websocket", "polling"],
    });

    const connectError = await new Promise<any>((resolve) => {
      client.on("connect_error", (err) => resolve(err));
    });
    expect(connectError).toBeDefined();
    client.close();
  });

  it("rejects unsigned demo tokens and arbitrary fleet IDs when demo mode is disabled", async () => {
    const prevDemo = config.demoMode;
    try {
      config.demoMode = false;

      const resDemoToken = await fetch(`${baseUrl}/api/vehicles`, {
        headers: {
          Authorization: `Bearer demo:${FLEET_A}:fleet_manager`,
        },
      });
      expect(resDemoToken.status).toBe(401);

      const resArbitrary = await fetch(`${baseUrl}/api/vehicles`, {
        headers: {
          "x-fleet-id": FLEET_A,
        },
      });
      expect(resArbitrary.status).toBe(401);

      const client: ClientSocket = Client(baseUrl, {
        auth: { fleetId: FLEET_A },
        transports: ["websocket", "polling"],
      });

      const connectErr = await new Promise<any>((resolve) => {
        client.on("connect_error", (err) => resolve(err));
      });
      expect(connectErr).toBeDefined();
      client.close();
    } finally {
      config.demoMode = prevDemo;
    }
  });

  it("enforces vehicle ownership on socket subscriptions", async () => {
    const tokenB = signAuthToken({
      userId: "user_beta_mgr",
      fleetId: FLEET_B,
      role: "fleet_manager",
    });

    const clientB: ClientSocket = Client(baseUrl, {
      auth: { token: tokenB },
      transports: ["websocket", "polling"],
    });

    await new Promise<void>((resolve) => clientB.on("connect", () => resolve()));

    const errorPromise = new Promise<any>((resolve) => {
      clientB.on("subscription:error", (err) => resolve(err));
    });

    clientB.emit("subscribe:vehicle", VEH_A);

    const subError = await errorPromise;
    expect(subError.vehicleId).toBe(VEH_A);
    expect(subError.message).toContain("unauthorized");

    clientB.close();
  });
});
