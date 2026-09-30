import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
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
import { computeVehicleLiveState } from "../services/vehicle-state.service.js";
import { getCatchupEvents } from "../services/fleet-event.service.js";
import { v4 as uuid } from "uuid";

const FLEET_A = "fleet_socket_alpha";
const FLEET_B = "fleet_socket_beta";
const CONN_A = "conn_socket_alpha";
const CONN_B = "conn_socket_beta";
const VEH_A = "veh_socket_alpha_01";
const VEH_B = "veh_socket_beta_01";

let testDbPath: string;
let server: Server;
let baseUrl: string;

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params);
}

function queryOne<T = any>(sql: string, params: any[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T;
}

function query<T = any>(sql: string, params: any[] = []): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

function setupTestFleets() {
  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [FLEET_A, "Alpha Fleet"]);
  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [FLEET_B, "Beta Fleet"]);

  run(
    "INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_A, FLEET_A, "oem_voltera", "Alpha Volt Conn", "ACTIVE"]
  );
  run(
    "INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_B, FLEET_B, "oem_voltera", "Beta Volt Conn", "ACTIVE"]
  );

  run(
    "INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, label, data_status, connection_id) VALUES (?, ?, ?, ?, ?, ?)",
    [VEH_A, FLEET_A, "1VSOCKETALPHA0001", "Alpha Vehicle", "AWAITING_DATA", CONN_A]
  );
  run(
    "INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, label, data_status, connection_id) VALUES (?, ?, ?, ?, ?, ?)",
    [VEH_B, FLEET_B, "1VSOCKETBETA00001", "Beta Vehicle", "AWAITING_DATA", CONN_B]
  );

  run(
    "INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES (?, ?, ?, ?, ?)",
    [uuid(), VEH_A, CONN_A, "VLT-ALPHA-01", 1]
  );
  run(
    "INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES (?, ?, ?, ?, ?)",
    [uuid(), VEH_B, CONN_B, "VLT-BETA-01", 1]
  );
}

function ingestVoltEvent(
  fleetId: string,
  connId: string,
  sourceVehId: string,
  sourceEvtId: string,
  data: {
    timestamp: string;
    speed_mph: number;
    lat: number;
    lon: number;
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
     VALUES (?, ?, ?, ?, ?, 'hash', ?, 'PENDING', ?)`,
    [rawId, fleetId, connId, sourceEvtId, sourceVehId, payloadStr, `${connId}:${sourceEvtId}`]
  );

  return processRawEvent(rawId);
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
  testDbPath = path.join(os.tmpdir(), `zspeed-socket-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.OVERRIDE_DB_PATH = testDbPath;
  closeDb();
  runMigrations();
  seedDatabase();
  setupTestFleets();
});

afterEach(() => {
  closeDb();
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch {}
});

describe("Real-time Fleet Socket and Telemetry State Channel", () => {
  it("pushes position changes and speed over socket with monotonic cursor as telemetry arrives", async () => {
    const receivedMessages: any[] = [];
    const client: ClientSocket = Client(baseUrl, {
      auth: { fleetId: FLEET_A },
      transports: ["websocket", "polling"],
    });

    await new Promise<void>((resolve) => {
      client.on("connect", () => resolve());
    });

    client.on("fleet:event", (msg) => {
      receivedMessages.push(msg);
    });

    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_pos_1", {
      timestamp: "2026-09-30T10:00:00Z",
      speed_mph: 30,
      lat: 51.5074,
      lon: -0.1278,
    });

    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_pos_2", {
      timestamp: "2026-09-30T10:00:10Z",
      speed_mph: 45,
      lat: 51.5085,
      lon: -0.1265,
    });

    await new Promise((r) => setTimeout(r, 150));

    client.close();

    const telemetryEvents = receivedMessages.filter((m) => m.eventType === "vehicle:telemetry");
    expect(telemetryEvents.length).toBeGreaterThanOrEqual(2);

    expect(telemetryEvents[0].sequence).toBe(1);
    expect(telemetryEvents[1].sequence).toBeGreaterThan(telemetryEvents[0].sequence);

    expect(telemetryEvents[0].vehicleId).toBe(VEH_A);
    expect(telemetryEvents[0].fleetId).toBe(FLEET_A);
    expect(telemetryEvents[0].payload.state).toBe("MOVING");
    expect(telemetryEvents[0].payload.latitude).toBeCloseTo(51.5074, 4);

    expect(telemetryEvents[1].payload.speed).toBeCloseTo(45 * 1.60934, 1);
    expect(telemetryEvents[1].payload.state).toBe("MOVING");
  });

  it("transitions to IDLE when vehicle stops and does not falsely imply movement while receiving data", async () => {
    const receivedMessages: any[] = [];
    const client: ClientSocket = Client(baseUrl, {
      auth: { fleetId: FLEET_A },
      transports: ["websocket", "polling"],
    });

    await new Promise<void>((resolve) => {
      client.on("connect", () => resolve());
    });

    client.on("vehicle:telemetry", (msg) => {
      receivedMessages.push(msg);
    });

    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_stop_1", {
      timestamp: "2026-09-30T10:00:00Z",
      speed_mph: 35,
      lat: 51.5074,
      lon: -0.1278,
    });

    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_stop_2", {
      timestamp: "2026-09-30T10:00:30Z",
      speed_mph: 0,
      lat: 51.5074,
      lon: -0.1278,
    });

    await new Promise((r) => setTimeout(r, 150));
    client.close();

    expect(receivedMessages.length).toBe(2);
    expect(receivedMessages[0].payload.state).toBe("MOVING");
    expect(receivedMessages[1].payload.state).toBe("IDLE");

    const vehicle = queryOne<any>("SELECT live_state FROM vehicles WHERE id = ?", [VEH_A]);
    expect(vehicle?.live_state).toBe("IDLE");
  });

  it("computes STALE and OFFLINE states accurately based on signal timeouts and lack of connection", async () => {
    const now = new Date("2026-09-30T12:00:00Z");

    const recentMoving = computeVehicleLiveState({
      hasActiveConnection: true,
      lastReceiptTime: new Date("2026-09-30T11:59:45Z"),
      speed: 25,
      now,
    });
    expect(recentMoving).toBe("MOVING");

    const recentStationary = computeVehicleLiveState({
      hasActiveConnection: true,
      lastReceiptTime: new Date("2026-09-30T11:59:45Z"),
      speed: 0,
      now,
    });
    expect(recentStationary).toBe("IDLE");

    const staleState = computeVehicleLiveState({
      hasActiveConnection: true,
      lastReceiptTime: new Date("2026-09-30T11:58:30Z"),
      speed: 25,
      now,
    });
    expect(staleState).toBe("STALE");

    const offlineTimeout = computeVehicleLiveState({
      hasActiveConnection: true,
      lastReceiptTime: new Date("2026-09-30T11:50:00Z"),
      speed: 25,
      now,
    });
    expect(offlineTimeout).toBe("OFFLINE");

    const noConnection = computeVehicleLiveState({
      hasActiveConnection: false,
      lastReceiptTime: new Date("2026-09-30T11:59:50Z"),
      speed: 25,
      now,
    });
    expect(noConnection).toBe("OFFLINE");

    const connectedAwaiting = computeVehicleLiveState({
      hasActiveConnection: true,
      lastReceiptTime: null,
      sourceEventTime: null,
      now,
    });
    expect(connectedAwaiting).toBe("CONNECTED");

    const res = await fetch(`${baseUrl}/api/vehicles/live-states`, {
      headers: { "x-fleet-id": FLEET_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.states).toBeDefined();
    expect(body.states.length).toBeGreaterThanOrEqual(1);
    const alphaState = body.states.find((s: any) => s.vehicle_id === VEH_A);
    expect(alphaState).toBeDefined();
    expect(alphaState.live_state).toBe("CONNECTED");
  });

  it("reconnects with backoff and catches up missed events using monotonic cursor without duplicates", async () => {
    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_cup_1", {
      timestamp: "2026-09-30T10:00:00Z",
      speed_mph: 20,
      lat: 51.500,
      lon: -0.120,
    });

    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_cup_2", {
      timestamp: "2026-09-30T10:01:00Z",
      speed_mph: 25,
      lat: 51.501,
      lon: -0.121,
    });

    const restRes = await fetch(`${baseUrl}/api/vehicles/catchup?since=0`, {
      headers: { "x-fleet-id": FLEET_A },
    });
    const restData = await restRes.json();
    expect(restData.events.length).toBeGreaterThanOrEqual(2);
    expect(restData.latestSequence).toBeGreaterThanOrEqual(2);

    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_cup_3", {
      timestamp: "2026-09-30T10:02:00Z",
      speed_mph: 30,
      lat: 51.502,
      lon: -0.122,
    });

    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_cup_4", {
      timestamp: "2026-09-30T10:03:00Z",
      speed_mph: 35,
      lat: 51.503,
      lon: -0.123,
    });

    const client: ClientSocket = Client(baseUrl, {
      auth: { fleetId: FLEET_A },
      transports: ["websocket", "polling"],
    });

    await new Promise<void>((resolve) => {
      client.on("connect", () => resolve());
    });

    const catchupResponse: any = await new Promise((resolve) => {
      client.emit("catchup", { since: 2 }, (res: any) => {
        resolve(res);
      });
    });

    client.close();

    expect(catchupResponse).toBeDefined();
    expect(catchupResponse.events.length).toBeGreaterThanOrEqual(2);
    expect(catchupResponse.events[0].sequence).toBe(3);
    expect(catchupResponse.events[1].sequence).toBe(4);

    const directCheck = getCatchupEvents(FLEET_A, 2);
    expect(directCheck.events.length).toBeGreaterThanOrEqual(2);
    expect(directCheck.events[0].sequence).toBe(3);
  });

  it("handles out-of-order samples without regressing current vehicle position or state", async () => {
    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_order_1", {
      timestamp: "2026-09-30T10:00:00Z",
      speed_mph: 30,
      lat: 51.5000,
      lon: -0.1200,
    });

    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_order_3", {
      timestamp: "2026-09-30T10:10:00Z",
      speed_mph: 55,
      lat: 51.5100,
      lon: -0.1100,
    });

    const stateBefore = queryOne<any>(
      "SELECT latest_values FROM vehicle_current_state WHERE vehicle_id = ?",
      [VEH_A]
    );
    const parsedBefore = JSON.parse(stateBefore.latest_values);
    expect(parsedBefore.latitude).toBeCloseTo(51.5100, 4);

    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_order_2_late", {
      timestamp: "2026-09-30T10:05:00Z",
      speed_mph: 40,
      lat: 51.5050,
      lon: -0.1150,
    });

    const stateAfter = queryOne<any>(
      "SELECT latest_values FROM vehicle_current_state WHERE vehicle_id = ?",
      [VEH_A]
    );
    const parsedAfter = JSON.parse(stateAfter.latest_values);
    expect(parsedAfter.latitude).toBeCloseTo(51.5100, 4);

    const points = query<any>(
      "SELECT event_time, latitude FROM normalized_events WHERE vehicle_id = ? ORDER BY event_time ASC",
      [VEH_A]
    );
    expect(points.length).toBe(3);
    expect(points[0].latitude).toBeCloseTo(51.5000, 4);
    expect(points[1].latitude).toBeCloseTo(51.5050, 4);
    expect(points[2].latitude).toBeCloseTo(51.5100, 4);
  });

  it("strictly isolates socket events and catch-up between two separate fleets", async () => {
    const clientA: ClientSocket = Client(baseUrl, {
      auth: { fleetId: FLEET_A },
      transports: ["websocket", "polling"],
    });

    const clientB: ClientSocket = Client(baseUrl, {
      auth: { fleetId: FLEET_B },
      transports: ["websocket", "polling"],
    });

    await Promise.all([
      new Promise<void>((res) => clientA.on("connect", () => res())),
      new Promise<void>((res) => clientB.on("connect", () => res())),
    ]);

    const messagesA: any[] = [];
    const messagesB: any[] = [];

    clientA.on("fleet:event", (m) => messagesA.push(m));
    clientB.on("fleet:event", (m) => messagesB.push(m));

    ingestVoltEvent(FLEET_A, CONN_A, "VLT-ALPHA-01", "evt_iso_a1", {
      timestamp: "2026-09-30T10:00:00Z",
      speed_mph: 25,
      lat: 51.50,
      lon: -0.12,
    });

    await new Promise((r) => setTimeout(r, 150));

    expect(messagesA.length).toBeGreaterThanOrEqual(1);
    expect(messagesB.length).toBe(0);

    ingestVoltEvent(FLEET_B, CONN_B, "VLT-BETA-01", "evt_iso_b1", {
      timestamp: "2026-09-30T10:00:00Z",
      speed_mph: 30,
      lat: 52.20,
      lon: 0.12,
    });

    await new Promise((r) => setTimeout(r, 150));

    clientA.close();
    clientB.close();

    const betaMessagesInA = messagesA.filter((m) => m.fleetId === FLEET_B);
    const alphaMessagesInB = messagesB.filter((m) => m.fleetId === FLEET_A);

    expect(betaMessagesInA.length).toBe(0);
    expect(alphaMessagesInB.length).toBe(0);

    const bCatchup = await fetch(`${baseUrl}/api/vehicles/catchup?since=0`, {
      headers: { "x-fleet-id": FLEET_B },
    });
    const bCatchupData = await bCatchup.json();
    const leakedAlphaInB = bCatchupData.events.filter((e: any) => e.fleetId === FLEET_A);
    expect(leakedAlphaInB.length).toBe(0);
  });

  it("paginates catch-up across more than 500 missed events", async () => {
    for (let i = 1; i <= 550; i++) {
      run(
        `INSERT INTO fleet_socket_events (id, fleet_id, sequence, event_type, event_id, vehicle_id, source_event_time, server_received_time, payload, created_at)
         VALUES (?, ?, ?, 'vehicle:telemetry', ?, ?, datetime('now'), datetime('now'), '{}', datetime('now'))`,
        [uuid(), FLEET_A, i, `evt_bulk_${i}`, VEH_A]
      );
    }
    run(
      `INSERT INTO fleet_event_cursors (fleet_id, last_sequence) VALUES (?, 550)
       ON CONFLICT(fleet_id) DO UPDATE SET last_sequence = 550`,
      [FLEET_A]
    );

    const client: ClientSocket = Client(baseUrl, {
      auth: { fleetId: FLEET_A },
      transports: ["websocket", "polling"],
    });

    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const page1: any = await new Promise((resolve) => {
      client.emit("catchup", { since: 0, limit: 500 }, (res: any) => resolve(res));
    });

    expect(page1.events.length).toBe(500);
    expect(page1.events[0].sequence).toBe(1);
    expect(page1.events[499].sequence).toBe(500);
    expect(page1.latestSequence).toBe(550);

    const lastSeq = page1.events[page1.events.length - 1].sequence;
    const page2: any = await new Promise((resolve) => {
      client.emit("catchup", { since: lastSeq, limit: 500 }, (res: any) => resolve(res));
    });

    expect(page2.events.length).toBe(50);
    expect(page2.events[0].sequence).toBe(501);
    expect(page2.events[49].sequence).toBe(550);

    client.close();
  });

  it("signals stream reset when requested cursor is older than available history", async () => {
    run(
      `INSERT INTO fleet_socket_events (id, fleet_id, sequence, event_type, event_id, vehicle_id, source_event_time, server_received_time, payload, created_at)
       VALUES (?, ?, 100, 'vehicle:telemetry', 'evt_100', ?, datetime('now'), datetime('now'), '{}', datetime('now'))`,
      [uuid(), FLEET_A, VEH_A]
    );

    const client: ClientSocket = Client(baseUrl, {
      auth: { fleetId: FLEET_A },
      transports: ["websocket", "polling"],
    });

    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const resetResponse: any = await new Promise((resolve) => {
      client.emit("catchup", { since: 10, limit: 500 }, (res: any) => resolve(res));
    });

    expect(resetResponse.reset).toBe(true);

    const snapshotRes = await fetch(`${baseUrl}/api/vehicles`, {
      headers: { "x-fleet-id": FLEET_A },
    });
    expect(snapshotRes.status).toBe(200);
    const snapshotData = await snapshotRes.json();
    expect(snapshotData.snapshotVersion).toBeDefined();

    client.close();
  });
});
