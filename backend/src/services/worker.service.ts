import { query, queryOne, run, transaction } from "../db/pool.js";
import { buildProjectionsForVehicle, runProjectionRebuildJob } from "./projection.service.js";
import { processRawEvent, runReplayJob } from "./ingestion.service.js";
import { recalculateFleetInsights } from "./insight.service.js";

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

export function claimNextJob(workerId: string = "worker-1", allowMaintenance=true): any | null {
  return transaction(() => {
    const job = queryOne<any>(
      `SELECT * FROM job_queue
       WHERE status = 'PENDING'
         AND (run_after IS NULL OR run_after <= datetime('now'))
         AND (?=1 OR job_type NOT IN ('REPLAY_JOB','REBUILD_PROJECTIONS_JOB') OR created_at<=datetime('now','-10 minutes'))
       ORDER BY CASE WHEN job_type IN ('REPLAY_JOB','REBUILD_PROJECTIONS_JOB') AND created_at<=datetime('now','-10 minutes') THEN 0 ELSE priority END ASC, created_at ASC
       LIMIT 1`, [allowMaintenance ? 1 : 0]
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
        if (!handleReplayJob(payload)) {
          run("UPDATE job_queue SET status='PENDING',worker_id=NULL,attempts=MAX(0,attempts-1),run_after=datetime('now','+1 seconds') WHERE id=?",[job.id]);
          return;
        }
        break;
      default:
        throw new Error(`Unknown job type: ${job.job_type}`);
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

export function processBatch(workerId: string = "worker-default", maxJobs=MAX_JOBS_PER_CYCLE, allowMaintenance=true): number {
  recoverAbandonedJobs(30);
  let processedCount = 0;
  const cycleStarted=Date.now();
  for (let i = 0; i < maxJobs; i++) {
    if(i>0 && Date.now()-cycleStarted>200) break;
    const job = claimNextJob(workerId,allowMaintenance);
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

  const res = buildProjectionsForVehicle(vehicleId, fromTime, to);
  if (res.errors && res.errors.length > 0) {
    throw new Error(`Projection rebuild failed: ${res.errors.join("; ")}`);
  }
  const v = queryOne<{ fleet_id: string }>("SELECT fleet_id FROM vehicles WHERE id = ?", [vehicleId]);
  if (v?.fleet_id) {
    try {
      recalculateFleetInsights(v.fleet_id);
    } catch {}
  }
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
  const result=queryOne<any>('SELECT status,error_message FROM projection_rebuild_jobs WHERE id=?',[jobId]);
  if(result?.status==='FAILED') throw new Error(result.error_message || 'Projection rebuild failed');
  const job = queryOne<{ fleet_id: string }>("SELECT fleet_id FROM projection_rebuild_jobs WHERE id = ?", [jobId]);
  if (job?.fleet_id) {
    try {
      recalculateFleetInsights(job.fleet_id);
    } catch {}
  }
}

function handleReplayJob(payload: any): boolean {
  const { jobId, mappingProfileId } = payload;
  if (!jobId || !mappingProfileId) throw new Error('Replay job requires a job and mapping profile');
  runReplayJob(jobId, mappingProfileId,25);
  const result=queryOne<any>('SELECT status,error_message FROM replay_jobs WHERE id=?',[jobId]);
  if(result?.status==='FAILED') throw new Error(result.error_message || 'Replay failed');
  return result?.status==='COMPLETED';
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
