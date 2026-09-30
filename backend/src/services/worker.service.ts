import { query, queryOne, run, transaction } from "../db/pool.js";
import { buildProjectionsForVehicle, runProjectionRebuildJob } from "./projection.service.js";
import { processRawEvent, runReplayJob } from "./ingestion.service.js";

const WORKER_INTERVAL_MS = 1000;
const MAX_JOBS_PER_CYCLE = 50;

let workerTimer: ReturnType<typeof setInterval> | null = null;

export function startWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(processBatch, WORKER_INTERVAL_MS);
}

export function stopWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

export function claimNextJob(workerId: string = "worker-1"): any | null {
  return transaction(() => {
    const job = queryOne<any>(
      `SELECT * FROM job_queue
       WHERE status = 'PENDING'
         AND (run_after IS NULL OR run_after <= datetime('now'))
       ORDER BY priority ASC, created_at ASC
       LIMIT 1`
    );

    if (!job) return null;

    const res = run(
      `UPDATE job_queue
       SET status = 'RUNNING',
           worker_id = ?,
           started_at = datetime('now'),
           attempts = attempts + 1
       WHERE id = ? AND status = 'PENDING'`,
      [workerId, job.id]
    );

    if (res.changes === 0) return null;

    return queryOne<any>("SELECT * FROM job_queue WHERE id = ?", [job.id]);
  });
}

export function recoverAbandonedJobs(timeoutSeconds: number = 30): number {
  return transaction(() => {
    const threshold = `-${timeoutSeconds} seconds`;
    const abandoned = query<any>(
      `SELECT * FROM job_queue
       WHERE status = 'RUNNING'
         AND started_at <= datetime('now', ?)`,
      [threshold]
    );

    for (const job of abandoned) {
      const maxAttempts = job.max_attempts || 3;
      if (job.attempts >= maxAttempts) {
        run(
          `UPDATE job_queue
           SET status = 'FAILED',
               error = 'Job abandoned and exceeded max attempts',
               completed_at = datetime('now')
           WHERE id = ?`,
          [job.id]
        );
      } else {
        run(
          `UPDATE job_queue
           SET status = 'PENDING',
               worker_id = NULL,
               error = 'Recovered abandoned job'
           WHERE id = ?`,
          [job.id]
        );
      }
    }
    return abandoned.length;
  });
}

export function executeClaimedJob(job: any): void {
  try {
    const payload = JSON.parse(job.payload || "{}");

    switch (job.job_type) {
      case "BUILD_PROJECTIONS":
        handleBuildProjections(payload);
        break;
      case "NORMALIZE_RAW_EVENT":
        handleNormalizeRawEvent(payload);
        break;
      case "REBUILD_PROJECTIONS_JOB":
        handleRebuildProjectionJob(payload);
        break;
      case "REPLAY_JOB":
        handleReplayJob(payload);
        break;
      default:
        console.warn("Unknown job type:", job.job_type);
    }

    run(
      "UPDATE job_queue SET status = 'DONE', completed_at = datetime('now') WHERE id = ?",
      [job.id]
    );
  } catch (e: any) {
    const maxAttempts = job.max_attempts || 3;
    if (job.attempts < maxAttempts) {
      const backoffSec = Math.min(60, Math.pow(2, job.attempts || 1));
      run(
        `UPDATE job_queue
         SET status = 'PENDING',
             worker_id = NULL,
             run_after = datetime('now', ?),
             error = ?
         WHERE id = ?`,
        [`+${backoffSec} seconds`, e.message, job.id]
      );
    } else {
      run(
        "UPDATE job_queue SET status = 'FAILED', error = ?, completed_at = datetime('now') WHERE id = ?",
        [e.message, job.id]
      );
    }
  }
}

export function processBatch(workerId: string = "worker-default"): number {
  recoverAbandonedJobs(30);
  let processedCount = 0;
  for (let i = 0; i < MAX_JOBS_PER_CYCLE; i++) {
    const job = claimNextJob(workerId);
    if (!job) break;
    executeClaimedJob(job);
    processedCount++;
  }
  return processedCount;
}

function handleBuildProjections(payload: any): void {
  const { vehicleId, eventTime, toTime } = payload;
  if (!vehicleId) return;

  const fromTime = eventTime
    ? new Date(new Date(eventTime).getTime() - 30 * 60 * 1000)
    : undefined;
  const to = toTime
    ? new Date(new Date(toTime).getTime() + 30 * 60 * 1000)
    : (eventTime ? new Date(new Date(eventTime).getTime() + 30 * 60 * 1000) : undefined);

  buildProjectionsForVehicle(vehicleId, fromTime, to);
}

function handleNormalizeRawEvent(payload: any): void {
  const { rawEventId } = payload;
  if (!rawEventId) return;
  processRawEvent(rawEventId);
}

function handleRebuildProjectionJob(payload: any): void {
  const { jobId } = payload;
  if (!jobId) return;
  runProjectionRebuildJob(jobId);
}

function handleReplayJob(payload: any): void {
  const { jobId, mappingProfileId } = payload;
  if (!jobId || !mappingProfileId) return;
  runReplayJob(jobId, mappingProfileId);
}

export function drainWorker(): void {
  let remaining = true;
  let maxCycles = 100;
  while (remaining && maxCycles-- > 0) {
    const pending = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM job_queue WHERE status = 'PENDING' AND (run_after IS NULL OR run_after <= datetime('now'))"
    );
    if ((pending?.count || 0) === 0) {
      remaining = false;
    } else {
      processBatch();
    }
  }
}

export function getQueueHealth(): {
  status: "HEALTHY" | "DEGRADED" | "DOWN";
  pending: number;
  running: number;
  completed: number;
  failed: number;
  oldest_pending_age_seconds: number | null;
  active_workers: string[];
} {
  const counts = queryOne<any>(
    `SELECT
       SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
       SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) as running,
       SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
     FROM job_queue`
  );

  const oldest = queryOne<{ age: number }>(
    `SELECT round((julianday('now') - julianday(created_at)) * 86400) as age
     FROM job_queue
     WHERE status = 'PENDING'
     ORDER BY created_at ASC LIMIT 1`
  );

  const workers = query<{ worker_id: string }>(
    `SELECT DISTINCT worker_id FROM job_queue WHERE status = 'RUNNING' AND worker_id IS NOT NULL`
  ).map((w) => w.worker_id);

  const pending = Number(counts?.pending) || 0;
  const running = Number(counts?.running) || 0;
  const completed = Number(counts?.completed) || 0;
  const failed = Number(counts?.failed) || 0;

  let status: "HEALTHY" | "DEGRADED" | "DOWN" = "HEALTHY";
  if (failed > 0 || (oldest?.age && oldest.age > 60)) {
    status = "DEGRADED";
  }

  return {
    status,
    pending,
    running,
    completed,
    failed,
    oldest_pending_age_seconds: oldest?.age ?? null,
    active_workers: workers,
  };
}
