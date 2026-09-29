import { query, queryOne, run } from "../db/pool.js";
import { buildProjectionsForVehicle, runProjectionRebuildJob } from "./projection.service.js";
import { processRawEvent } from "./ingestion.service.js";

const WORKER_INTERVAL_MS = 2000;
const MAX_JOBS_PER_CYCLE = 10;

let workerTimer: ReturnType<typeof setInterval> | null = null;

export function startWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(processBatch, WORKER_INTERVAL_MS);
  console.log("Worker started.");
}

export function stopWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

function processBatch(): void {
  try {
    const jobs = query<any>(
      `SELECT * FROM job_queue
       WHERE status = 'PENDING'
       ORDER BY priority ASC, created_at ASC
       LIMIT ?`,
      [MAX_JOBS_PER_CYCLE]
    );

    for (const job of jobs) {
      processJob(job);
    }
  } catch (e: any) {
    console.error("Worker error:", e.message);
  }
}

function processJob(job: any): void {
  run(
    "UPDATE job_queue SET status = 'RUNNING', started_at = datetime('now') WHERE id = ?",
    [job.id]
  );

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
      default:
        console.warn("Unknown job type:", job.job_type);
    }

    run(
      "UPDATE job_queue SET status = 'DONE', completed_at = datetime('now') WHERE id = ?",
      [job.id]
    );
  } catch (e: any) {
    run(
      "UPDATE job_queue SET status = 'FAILED', error = ?, completed_at = datetime('now') WHERE id = ?",
      [e.message, job.id]
    );
  }
}

function handleBuildProjections(payload: any): void {
  const { vehicleId, eventTime } = payload;
  if (!vehicleId) return;

  const fromTime = eventTime
    ? new Date(new Date(eventTime).getTime() - 24 * 60 * 60 * 1000)
    : undefined;

  buildProjectionsForVehicle(vehicleId, fromTime);
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

export function drainWorker(): void {
  let remaining = true;
  let maxCycles = 100;
  while (remaining && maxCycles-- > 0) {
    const jobs = query<any>(
      "SELECT COUNT(*) as count FROM job_queue WHERE status = 'PENDING'",
      []
    );
    if ((jobs[0]?.count || 0) === 0) {
      remaining = false;
    } else {
      processBatch();
    }
  }
}
