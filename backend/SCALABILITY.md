# Scalability and Migration Path

ZSpeed's initial architecture leverages SQLite (in WAL mode) for rapid prototyping, zero-dependency deployment, and single-node vertical scaling. However, as the connected vehicle platform scales to process thousands of events per second across hundreds of thousands of vehicles, the system will need to migrate to a distributed data layer.

This document outlines the strategic migration path from the current SQLite-based architecture to a horizontally scalable stack using Kafka and PostgreSQL.

## Current Architecture (SQLite)

- **Ingestion:** API endpoints write directly to `raw_events` table.
- **Processing:** Background worker (`worker.service.ts`) polls for unprocessed events and generates `normalized_events`.
- **Projection:** Background worker polls normalized events to build `trips` and `route` data.
- **Transactions:** Handled by single-writer lock in SQLite. WAL mode allows concurrent reads.

**Limits of current architecture:**
- Write throughput is bounded by single-disk IOPS (typically caps around 10k-50k writes/sec depending on hardware and durability settings).
- Polling for jobs (even with delays) creates artificial latency and CPU overhead.
- Cannot scale the backend API and worker processes across multiple servers easily without file-locking contention over the network.

## Target Architecture (Kafka + PostgreSQL)

The migration to a high-throughput architecture decouples ingestion from processing and distributes database load.

### 1. Ingestion via Apache Kafka (or Redpanda)
Instead of writing raw events directly to the database during the HTTP request:
- The backend API validates the payload signature and pushes it to a Kafka topic (e.g., `telemetry.raw`).
- The API responds `202 Accepted` immediately, providing ultra-low latency for OEM webhook endpoints.
- **Why Kafka?** It buffers traffic spikes effortlessly and provides immutable event sourcing.

### 2. Processing Workers (Kafka Consumers)
- The background worker service transitions into a Kafka consumer group.
- Multiple worker instances can consume the `telemetry.raw` topic concurrently, partitioned by `vehicle_id` (ensuring events for a specific vehicle are always processed in order).
- The worker normalizes the event, executes the quarantine checks, and pushes valid events to a `telemetry.normalized` topic.

### 3. Persistent Storage (PostgreSQL)
- SQLite is replaced by PostgreSQL for durable, concurrent storage.
- PostgreSQL handles the relational state: `vehicles`, `oem_connections`, `quarantine_incidents`, `trips`.
- **TimescaleDB Extension (Optional):** Since `normalized_events` is time-series data, TimescaleDB can be used to partition the data dynamically and maintain high insert rates without index bloat.

### 4. Projection Engine
- A dedicated consumer group listens to `telemetry.normalized` to update the `trips` and vehicle current state in PostgreSQL.
- Idempotency is maintained via database constraints (e.g., UPSERTs on trip IDs).

## Step-by-Step Migration Plan

A "big bang" rewrite is risky. We recommend a phased transition:

### Phase 1: Abstract Database Access (Preparation)
- *Current State:* Database queries use `better-sqlite3` directly in services.
- *Action:* Introduce the Repository Pattern (e.g., `VehicleRepository`, `TripRepository`).
- *Goal:* Centralize all SQL statements so that swapping the underlying driver is isolated to the repositories.

### Phase 2: Introduce PostgreSQL
- *Action:* Create PostgreSQL schema definitions equivalent to the current SQLite schema.
- *Action:* Implement PostgreSQL versions of the repositories.
- *Action:* Perform a one-time data migration script to copy state from SQLite to PostgreSQL.
- *Deployment:* Update configuration to point services at PostgreSQL. The application is still a monolith, but now backed by a concurrent DB.

### Phase 3: Introduce Kafka for Ingestion
- *Action:* Deploy Kafka.
- *Action:* Modify the API ingest route to publish to Kafka instead of writing to the DB.
- *Action:* Create an Ingestion Consumer that reads from Kafka and writes to the `raw_events` table (or directly invokes the normalization pipeline).
- *Goal:* The web API is now decoupled from database write bottlenecks.

### Phase 4: Split Monolith into Microservices (Optional)
- *Action:* Separate the backend into an `api-server` (handles HTTP) and a `processing-worker` (consumes Kafka).
- *Goal:* Independent scaling of HTTP ingress vs. background processing.

## Managing Schema Evolutions & Quarantine
In the distributed model, the quarantine flow remains crucial. If a schema change occurs:
- The worker detects the error and flags it.
- Instead of just saving to a SQLite table, it routes the failed raw event to a Dead Letter Queue (DLQ) topic in Kafka, and updates the `quarantine_incidents` table in PostgreSQL.
- Upon resolution (e.g., new mapping), the administrator triggers a replay, which pulls events from the DLQ back into the main processing topic.

## Summary
The system has been specifically designed to accommodate this shift:
- The concept of `raw_events` acts as a precursor to an event-sourced topic.
- The `worker.service.ts` logic already acts like a decoupled consumer loop.
- The `quarantine` status pipeline operates asynchronously.

Moving to Kafka + PostgreSQL will require infrastructure changes and query syntax updates, but the core domain logic (Trip Building, Route Simplification, Event Normalization) will remain entirely intact.
