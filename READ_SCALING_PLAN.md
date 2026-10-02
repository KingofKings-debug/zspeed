# Vehicle reads and background processing

The operational database remains the source of truth. Vehicle summaries and trip bundles are rebuilt asynchronously into a separate SQLite read database and replicated into a second database. Readers may see an older completed snapshot while updates are queued. Redis is an optional cache; cache failures must not prevent reads.

## Implementation checklist

- [x] Persist a durable, coalescing refresh queue when vehicle, trip, or quarantine data changes.
- [x] Build separate vehicle summaries, health tags, statistics, and complete trip bundles without scanning event history on client reads.
- [x] Replicate completed snapshots to a separate read database; preserve the previous snapshot on failed updates.
- [x] Serve vehicle and trip reads from the replica with fleet ownership checks and freshness information.
- [x] Fetch each selected trip's map, important events, and quality in one request.
- [x] Add optional Redis caching with bounded waits and database fallback.
- [x] Run background processing outside the HTTP process, with busy-period throttling, quiet-hour maintenance, and retry recovery.
- [x] Add a Backend Jobs tab showing queue progress, failures, replica freshness, and cache availability.
- [x] Wire worker, read storage, and Redis into Docker deployment and document configuration and startup.
- [x] Add tests for refresh coalescing, snapshot building, replication, tenant isolation, cache failures, scheduling, and bundled reads; run regression tests and production builds.

## Verification

- Backend regression and focused checks: 200 passing tests, including 22 read-scaling tests and eight activity/refresh tests. One opt-in real Redis container test is skipped unless `RUN_DOCKER_TESTS=1`.
- Backend and frontend production builds pass.
- Browser preview: vehicle quality counts, trip map/events, summary freshness, health tags and Backend Jobs displayed correctly against an isolated database.
- Worker restart: stopped the isolated worker and verified that its supervisor launched a replacement and restored its heartbeat.
- Lost read database and replica recovery are covered by automated tests.
- Docker is not installed on this machine. The full container stack and real Redis integration remain unverified here; the opt-in test and configuration are provided in `DEPLOYMENT.md`.

## Product activity and live updates

- [x] Group continuous vehicle processing under a stable activity ID, with a five-minute inactivity boundary.
- [x] Show vehicle, purpose, first start time, status, record/task totals, progress and review counts in one row.
- [x] Use customer-facing language on Background Jobs and Data Pipeline.
- [x] Keep Pipeline content mounted during background refreshes, coalesce notifications and preserve last results after failures.
- [x] Add eight activity/refresh tests; regression suite and production builds pass.

## Reliability boundaries

This deployment uses a durable database queue rather than introducing Kafka into the existing single-host SQLite platform. A separate replica reduces query contention; it does not provide host failover. Background work must make progress even under sustained traffic. No automatic job may discard original events or invent missing telemetry.
