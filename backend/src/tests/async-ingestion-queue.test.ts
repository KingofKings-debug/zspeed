import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import type { Server } from "http";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";
import { getDb, closeDb } from "../db/pool.js";
import { app } from "../index.js";
import {
  claimNextJob,
  recoverAbandonedJobs,
  drainWorker,
  executeClaimedJob,
} from "../services/worker.service.js";
import { processRawEvent } from "../services/ingestion.service.js";
import { v4 as uuid } from "uuid";

const FLEET_ID = "fleet_async_test";
const CONN_ID = "conn_async_voltera";
const VEH_ID = "veh_async_001";
const OEM_VEH_ID = "VLT-ASYNC-001";

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

function setupTestFleet() {
  run("INSERT OR IGNORE INTO fleets (id, name) VALUES (?, ?)", [FLEET_ID, "Async Test Fleet"]);
  run("INSERT OR IGNORE INTO oem_connections (id, fleet_id, oem_id, label, status) VALUES (?, ?, ?, ?, ?)",
    [CONN_ID, FLEET_ID, "oem_voltera", "Async Conn", "ACTIVE"]);
  run("INSERT OR IGNORE INTO vehicles (id, fleet_id, vin, data_status) VALUES (?, ?, ?, ?)",
    [VEH_ID, FLEET_ID, "1VASYNCVIN0000001", "NO_CONNECTION"]);
  run("INSERT OR IGNORE INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified) VALUES (?, ?, ?, ?, ?)",
    [uuid(), VEH_ID, CONN_ID, OEM_VEH_ID, 1]);
}

function validVolteraV1Payload(speed = 45, lat = 51.5074, lon = -0.1278) {
  return {
    timestamp: "2026-09-30T10:00:00Z",
    speed_mph: speed,
    charge_fraction: 0.85,
    odo_miles: 12000,
    status: "running",
    lat,
    lon,
    altitude: 15,
    heading: 180,
    harsh_brake: false,
  };
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
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
  testDbPath = path.join(os.tmpdir(), `zspeed_test_async_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  process.env.OVERRIDE_DB_PATH = testDbPath;
  closeDb();
  runMigrations();
  seedDatabase();
  setupTestFleet();
});

afterEach(() => {
  closeDb();
  try { fs.unlinkSync(testDbPath); } catch {}
  try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
  try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  delete process.env.OVERRIDE_DB_PATH;
});

describe("Asynchronous Ingestion and Durable Worker Queue", () => {
  it("route returns 202 and raw event ID before normalization completes", async () => {
    const res = await fetch(`${baseUrl}/api/ingestion/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_ID}:fleet_manager`,
      },
      body: JSON.stringify({
        connection_id: CONN_ID,
        source_vehicle_id: OEM_VEH_ID,
        source_event_id: "evt_async_001",
        payload: validVolteraV1Payload(50),
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.status).toBe("ACCEPTED");
    expect(body.eventId).toBeDefined();

    const raw = queryOne<any>("SELECT * FROM raw_events WHERE id = ?", [body.eventId]);
    expect(raw).toBeDefined();
    expect(raw.processing_status).toBe("PENDING");

    const queuedJob = queryOne<any>(
      "SELECT * FROM job_queue WHERE job_type = 'NORMALIZE_RAW_EVENT' AND status = 'PENDING'"
    );
    expect(queuedJob).toBeDefined();
    expect(JSON.parse(queuedJob.payload).rawEventId).toBe(body.eventId);

    const normBefore = queryOne<any>("SELECT * FROM normalized_events WHERE raw_event_id = ?", [body.eventId]);
    expect(normBefore).toBeUndefined();

    drainWorker();

    const queuedJobAfter = queryOne<any>("SELECT * FROM job_queue WHERE id = ?", [queuedJob.id]);
    expect(queuedJobAfter.status).toBe("DONE");

    const rawAfter = queryOne<any>("SELECT * FROM raw_events WHERE id = ?", [body.eventId]);
    expect(rawAfter.processing_status).toBe("PROCESSED");

    const normAfter = queryOne<any>("SELECT * FROM normalized_events WHERE raw_event_id = ?", [body.eventId]);
    expect(normAfter).toBeDefined();
    expect(normAfter.vehicle_id).toBe(VEH_ID);
  });

  it("handles identical retries idempotently without duplicate raw, queue, or normalized records", async () => {
    const payload = validVolteraV1Payload(40);

    const res1 = await fetch(`${baseUrl}/api/ingestion/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_ID}:fleet_manager`,
      },
      body: JSON.stringify({
        connection_id: CONN_ID,
        source_vehicle_id: OEM_VEH_ID,
        source_event_id: "evt_dup_001",
        payload,
      }),
    });
    expect(res1.status).toBe(202);
    const body1 = await res1.json() as any;

    const res2 = await fetch(`${baseUrl}/api/ingestion/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_ID}:fleet_manager`,
      },
      body: JSON.stringify({
        connection_id: CONN_ID,
        source_vehicle_id: OEM_VEH_ID,
        source_event_id: "evt_dup_001",
        payload,
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as any;
    expect(body2.status).toBe("DUPLICATE");
    expect(body2.eventId).toBe(body1.eventId);

    const rawCount = queryOne<any>(
      "SELECT COUNT(*) as count FROM raw_events WHERE source_event_id = 'evt_dup_001'"
    ).count;
    expect(rawCount).toBe(1);

    const jobCount = queryOne<any>(
      "SELECT COUNT(*) as count FROM job_queue WHERE job_type = 'NORMALIZE_RAW_EVENT'"
    ).count;
    expect(jobCount).toBe(1);

    drainWorker();

    const normCount = queryOne<any>(
      "SELECT COUNT(*) as count FROM normalized_events WHERE raw_event_id = ?",
      [body1.eventId]
    ).count;
    expect(normCount).toBe(1);

    const resNoId1 = await fetch(`${baseUrl}/api/ingestion/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_ID}:fleet_manager`,
      },
      body: JSON.stringify({
        connection_id: CONN_ID,
        source_vehicle_id: OEM_VEH_ID,
        payload: validVolteraV1Payload(62),
      }),
    });
    expect(resNoId1.status).toBe(202);

    const resNoId2 = await fetch(`${baseUrl}/api/ingestion/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_ID}:fleet_manager`,
      },
      body: JSON.stringify({
        connection_id: CONN_ID,
        source_vehicle_id: OEM_VEH_ID,
        payload: validVolteraV1Payload(62),
      }),
    });
    expect(resNoId2.status).toBe(200);
    const bodyNoId2 = await resNoId2.json() as any;
    expect(bodyNoId2.status).toBe("DUPLICATE");
  });

  it("reused source event ID with changed body creates visible quarantine conflict and not a second successful event", async () => {
    const payloadA = validVolteraV1Payload(30);
    const resA = await fetch(`${baseUrl}/api/ingestion/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_ID}:fleet_manager`,
      },
      body: JSON.stringify({
        connection_id: CONN_ID,
        source_vehicle_id: OEM_VEH_ID,
        source_event_id: "evt_conflict_unique_1",
        payload: payloadA,
      }),
    });
    expect(resA.status).toBe(202);
    drainWorker();

    const normA = query<any>("SELECT * FROM normalized_events WHERE vehicle_id = ?", [VEH_ID]);
    expect(normA.length).toBe(1);

    const payloadB = validVolteraV1Payload(75);
    const resB = await fetch(`${baseUrl}/api/ingestion/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_ID}:fleet_manager`,
      },
      body: JSON.stringify({
        connection_id: CONN_ID,
        source_vehicle_id: OEM_VEH_ID,
        source_event_id: "evt_conflict_unique_1",
        payload: payloadB,
      }),
    });
    expect(resB.status).toBe(202);
    const bodyB = await resB.json() as any;
    expect(bodyB.status).toBe("QUARANTINED");

    const conflictRaw = queryOne<any>("SELECT * FROM raw_events WHERE id = ?", [bodyB.eventId]);
    expect(conflictRaw.processing_status).toBe("QUARANTINED");

    const conflictRecord = queryOne<any>(
      "SELECT * FROM quarantine_records WHERE raw_event_id = ?",
      [bodyB.eventId]
    );
    expect(conflictRecord).toBeDefined();
    expect(conflictRecord.failure_category).toBe("IDEMPOTENCY_CONFLICT");

    drainWorker();

    const normAfter = query<any>("SELECT * FROM normalized_events WHERE vehicle_id = ?", [VEH_ID]);
    expect(normAfter.length).toBe(1);
  });

  it("concurrent workers claim pending jobs atomically with zero overlap", async () => {
    for (let i = 0; i < 6; i++) {
      await fetch(`${baseUrl}/api/ingestion/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer demo:${FLEET_ID}:fleet_manager`,
        },
        body: JSON.stringify({
          connection_id: CONN_ID,
          source_vehicle_id: OEM_VEH_ID,
          source_event_id: `evt_concurrent_${i}`,
          payload: validVolteraV1Payload(20 + i),
        }),
      });
    }

    const pendingCount = queryOne<any>(
      "SELECT COUNT(*) as count FROM job_queue WHERE status = 'PENDING'"
    ).count;
    expect(pendingCount).toBe(6);

    const workerAClaims: string[] = [];
    const workerBClaims: string[] = [];

    const claimPromises = Array.from({ length: 6 }).map((_, idx) => {
      const workerId = idx % 2 === 0 ? "worker-A" : "worker-B";
      return Promise.resolve().then(() => {
        const claimed = claimNextJob(workerId);
        if (claimed) {
          if (workerId === "worker-A") workerAClaims.push(claimed.id);
          else workerBClaims.push(claimed.id);
          executeClaimedJob(claimed);
        }
      });
    });

    await Promise.all(claimPromises);

    const overlap = workerAClaims.filter((id) => workerBClaims.includes(id));
    expect(overlap.length).toBe(0);
    expect(workerAClaims.length + workerBClaims.length).toBe(6);

    const doneCount = queryOne<any>(
      "SELECT COUNT(*) as count FROM job_queue WHERE status = 'DONE'"
    ).count;
    expect(doneCount).toBe(6);
  });

  it("recovers abandoned RUNNING jobs after process restart or heartbeat timeout", async () => {
    const rawId = uuid();
    run(
      `INSERT INTO raw_events (id, fleet_id, connection_id, source_event_id, source_vehicle_id, payload_hash, payload, processing_status)
       VALUES (?, ?, ?, 'evt_restart_1', ?, 'dummyhash', ?, 'PENDING')`,
      [rawId, FLEET_ID, CONN_ID, OEM_VEH_ID, JSON.stringify(validVolteraV1Payload(55))]
    );

    const jobId = uuid();
    run(
      `INSERT INTO job_queue (id, job_type, payload, status, priority, attempts, max_attempts, worker_id, started_at)
       VALUES (?, 'NORMALIZE_RAW_EVENT', ?, 'RUNNING', 5, 1, 3, 'crashed-worker-99', datetime('now', '-50 seconds'))`,
      [jobId, JSON.stringify({ rawEventId: rawId })]
    );

    const recoveredCount = recoverAbandonedJobs(30);
    expect(recoveredCount).toBe(1);

    const recoveredJob = queryOne<any>("SELECT * FROM job_queue WHERE id = ?", [jobId]);
    expect(recoveredJob.status).toBe("PENDING");
    expect(recoveredJob.worker_id).toBeNull();
    expect(recoveredJob.error).toBe("Recovered abandoned job");

    drainWorker();

    const finishedJob = queryOne<any>("SELECT * FROM job_queue WHERE id = ?", [jobId]);
    expect(finishedJob.status).toBe("DONE");

    const deadJobId = uuid();
    run(
      `INSERT INTO job_queue (id, job_type, payload, status, priority, attempts, max_attempts, worker_id, started_at)
       VALUES (?, 'NORMALIZE_RAW_EVENT', ?, 'RUNNING', 5, 3, 3, 'crashed-worker-exhausted', datetime('now', '-50 seconds'))`,
      [deadJobId, JSON.stringify({ rawEventId: rawId })]
    );

    recoverAbandonedJobs(30);

    const exhaustedJob = queryOne<any>("SELECT * FROM job_queue WHERE id = ?", [deadJobId]);
    expect(exhaustedJob.status).toBe("FAILED");
  });

  it("poison events do not crash worker and route failures cleanly to quarantine", async () => {
    const poisonPayload = {
      unrecognized_root: true,
      corrupt_value: [null, undefined],
    };

    const res = await fetch(`${baseUrl}/api/ingestion/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer demo:${FLEET_ID}:fleet_manager`,
      },
      body: JSON.stringify({
        connection_id: CONN_ID,
        source_vehicle_id: OEM_VEH_ID,
        source_event_id: "evt_poison_001",
        payload: poisonPayload,
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json() as any;

    expect(() => drainWorker()).not.toThrow();

    const raw = queryOne<any>("SELECT * FROM raw_events WHERE id = ?", [body.eventId]);
    expect(raw.processing_status).toBe("QUARANTINED");

    const record = queryOne<any>("SELECT * FROM quarantine_records WHERE raw_event_id = ?", [body.eventId]);
    expect(record).toBeDefined();

    const job = queryOne<any>("SELECT * FROM job_queue WHERE job_type = 'NORMALIZE_RAW_EVENT' AND status = 'DONE'");
    expect(job).toBeDefined();
  });

  it("successful reprocessing normalizes previously quarantined event", async () => {
    const rawId = uuid();
    const payload = validVolteraV1Payload(48);
    run(
      `INSERT INTO raw_events (id, fleet_id, connection_id, source_event_id, source_vehicle_id, payload_hash, payload, processing_status)
       VALUES (?, ?, ?, 'evt_reprocess_1', ?, 'reproc_hash', ?, 'QUARANTINED')`,
      [rawId, FLEET_ID, CONN_ID, OEM_VEH_ID, JSON.stringify(payload)]
    );

    const res = processRawEvent(rawId);
    expect(res.status).toBe("PROCESSED");

    const rawAfter = queryOne<any>("SELECT * FROM raw_events WHERE id = ?", [rawId]);
    expect(rawAfter.processing_status).toBe("PROCESSED");

    const norm = queryOne<any>("SELECT * FROM normalized_events WHERE raw_event_id = ?", [rawId]);
    expect(norm).toBeDefined();
  });

  it("exposes queue health metrics accurately via GET /api/ingestion/queue-health", async () => {
    const res = await fetch(`${baseUrl}/api/ingestion/queue-health`, {
      headers: {
        Authorization: `Bearer demo:${FLEET_ID}:fleet_manager`,
      },
    });

    expect(res.status).toBe(200);
    const health = await res.json() as any;
    expect(health.status).toBeDefined();
    expect(typeof health.pending).toBe("number");
    expect(typeof health.running).toBe("number");
    expect(typeof health.completed).toBe("number");
    expect(typeof health.failed).toBe("number");
    expect(Array.isArray(health.active_workers)).toBe(true);
  });

  it("injected failures between processing stages recover cleanly without partial state or duplicates", () => {
    const rawId = uuid();
    const payload = validVolteraV1Payload(50);

    run(
      `INSERT INTO raw_events (id, fleet_id, connection_id, source_event_id, source_vehicle_id, payload_hash, payload, processing_status)
       VALUES (?, ?, ?, 'evt_tx_failure_01', ?, 'hash', ?, 'PENDING')`,
      [rawId, FLEET_ID, CONN_ID, OEM_VEH_ID, JSON.stringify(payload)]
    );

    run(
      `CREATE TRIGGER fail_vehicle_current_state
       BEFORE INSERT ON vehicle_current_state
       BEGIN
         SELECT RAISE(FAIL, 'Simulated failure during vehicle_current_state update');
       END`
    );

    expect(() => processRawEvent(rawId)).toThrow();

    const normCount = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM normalized_events WHERE raw_event_id = ?", [rawId]);
    expect(normCount?.c).toBe(0);

    const socketCount = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM fleet_socket_events WHERE event_id = ?", [rawId]);
    expect(socketCount?.c).toBe(0);

    const rawStatus = queryOne<{ processing_status: string }>("SELECT processing_status FROM raw_events WHERE id = ?", [rawId]);
    expect(rawStatus?.processing_status).toBe("PENDING");

    run("DROP TRIGGER fail_vehicle_current_state");

    const retryRes = processRawEvent(rawId);
    expect(retryRes.status).toBe("PROCESSED");

    const normAfter = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM normalized_events WHERE raw_event_id = ?", [rawId]);
    expect(normAfter?.c).toBe(1);

    const socketAfter = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM fleet_socket_events WHERE event_id = ? AND event_type = 'vehicle:telemetry'", [rawId]);
    expect(socketAfter?.c).toBe(1);

    const rawStatusAfter = queryOne<{ processing_status: string }>("SELECT processing_status FROM raw_events WHERE id = ?", [rawId]);
    expect(rawStatusAfter?.processing_status).toBe("PROCESSED");
  });
});
