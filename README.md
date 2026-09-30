# ZSpeed Fleet Operations Platform

This is the first working milestone of the ZSpeed Fleet Operations connected-vehicle platform.

## Architecture

*   **Frontend**: React, TypeScript, Vite. A lightweight, responsive, client-side application.
*   **Backend**: Express.js, TypeScript. Handles all business logic, validation, and connection management.
*   **Database**: SQLite (`better-sqlite3`). Chosen for seamless local development and demonstration without requiring Docker or external PostgreSQL services while still providing robust ACID persistence across restarts.

## Features Implemented

1.  **Vehicle Onboarding (CSV Import)**:
    *   Row-level validation.
    *   Duplicate detection against existing fleet vehicles.
    *   Replaceable VIN-decoding service suggesting fictional manufacturers.
    *   Explicit confirmation step.
2.  **OEM Connection Management**:
    *   Clear tracking of unsupported OEMs vs. supported OEMs.
    *   Setup wizard with simulated authorization, vehicle discovery, capability selection, and activation.
    *   Stateful tracking distinguishing between an active account connection and vehicles actually receiving data telemetry.
3.  **Data Pipeline & Ingestion**:
    *   **Raw Event Storage**: Every payload is saved in its original format.
    *   **Versioned Mapping**: `mapping_profiles` and `mapping_rules` translate OEM-specific nested structures and types into canonical forms.
    *   **Idempotency**: Strict checks on `(fleet_id, connection_id, source_event_id, payload_hash)` prevent duplicate alerts and state updates.
    *   **Quarantine & Replay**: Unknown formats or validation failures place events into quarantine. After resolving the mapping, these events can be replayed to correct vehicle states.
4.  **Fleet State Tracking**:
    *   Separate statuses for vehicle mapping: `AWAITING_DATA`, `RECEIVING`, `NO_CONNECTION`, etc.
    *   Connection health monitoring and lifecycle states (`ACTIVE`, `DEGRADED`, etc.).

## How to Run Locally

### 1. Start Platform Backend
```bash
cd backend
npm install
npm run dev
```
The backend runs migrations, seeds the database, and listens on `http://localhost:3001`.

### 2. Start Independent OEM Simulator Backend
```bash
cd backend
npm run simulator
```
The OEM simulator server starts on `http://localhost:3002` with its isolated database in `data/simulator.db`. For full architectural and scenario details, see [SIMULATOR.md](./SIMULATOR.md).

### 3. Start Fleet Manager Frontend
```bash
cd frontend
npm install
npm run dev
```
The client-facing fleet manager frontend will be available at `http://localhost:5173`. It receives live telemetry updates via authenticated fleet-scoped Socket.IO streams without any direct dependency on the simulator console.

### 4. Start Standalone OEM Simulator Console
```bash
cd simulator-ui
npm install
npm run dev
```
The dedicated simulator testing console will be available at `http://localhost:5174`. It communicates with the simulator backend on port 3002 to control simulation runs, seed/speed settings, delivery outage toggles, failure scenarios, and view live physical vehicle telemetry and pipeline progression diagnostics.

### 5. Run Tests
```bash
cd backend
npm test
```

## Sample Data
A downloadable sample CSV is available directly from the UI or located in `sample-data/fleet-sample.csv`. It contains mixed scenarios including valid VINs from supported OEMs, unknown manufacturers, and deliberate duplicates to test the import validation flow.

## Next Implementation Stage (Connector Integration)

In this milestone, OEM connectors are simulated via the `OemConnectorInterface` in `backend/src/connectors/index.ts`. 
To integrate a real OEM:
1. Implement the `OemConnectorInterface` against the OEM's actual REST or Streaming API.
2. Store the real OAuth tokens securely (e.g. using a KMS or encrypted database column).
3. Connect the `activate` method to a real telemetry ingestion pipeline (like Kafka or Pub/Sub).
The fleet-facing API contracts and React interface will not need to change when these real implementations are swapped in.

## Future Scale Migration: PostgreSQL & Event Broker

Currently, this milestone relies exclusively on a unified SQLite database (`better-sqlite3`) to simplify local testing of idempotency, quarantine, and replay scenarios. In a production deployment handling high-throughput telemetry, the architecture is designed to cleanly transition:

1. **Relational Data to PostgreSQL**: The repositories in `backend/src/repositories/` currently wrap SQLite synchronous calls. By swapping these implementations for a Postgres driver (e.g., `pg`), state and relationship data can be horizontally scaled.
2. **Event Processing to a Broker**: The `ingestion.service.ts` directly processes raw payloads. At scale, this ingestion service would act purely as a consumer off a durable event broker (like Apache Kafka, AWS Kinesis, or Google Pub/Sub). Raw events would be dumped directly into the broker, buffering the mapping/normalization engine from ingestion spikes and simplifying multi-node replay jobs.
