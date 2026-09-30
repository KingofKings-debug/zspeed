# Independent OEM Simulation Server & Integration Guide

The ZSpeed OEM Simulator is an independent simulation server running as a separate process on port `3002` with its own isolated SQLite persistence (`data/simulator.db`). It simulates external automotive OEM cloud platforms, providing realistic API contracts, continuous kinematics physics, route-following navigation, and controlled failure scenarios.

## End-to-End Demonstration Path

```
Simulated Vehicle (Kinematics & Routes)
      ↓
Simulated OEM HTTP API (Voltera Token REST, Crestline Key REST, HMAC Webhooks)
      ↓
Platform OEM Connector (Jittered Polling, Cursors, Webhook Verification)
      ↓
Durable Processing Queue (Idempotent Raw Event Storage)
      ↓
Worker Normalization or Quarantine (Format Validation & Mapping Profiles)
      ↓
Vehicle / Trip / Insight Projections (MapLibre GPS Routes, Insight Cards)
      ↓
Live Frontend Updates (Fleet-Scoped Socket.IO Streaming)
```

---

## 1. System Architecture & Isolation

- **Independent Server Process**: Runs on port `3002` (configurable via `SIMULATOR_PORT`).
- **Storage Isolation**: Persists simulation runs, vehicles, samples, scenarios, and subscriptions exclusively in `data/simulator.db`. It never accesses or writes to the platform database (`data/zspeed.db`).
- **No Direct Frontend Updates**: The simulator does not emit Socket.IO events to the frontend. All live tracking and map telemetry in the UI originate strictly from platform backend updates.
- **Configurable Connector URLs**: Each platform connector points to its respective OEM base URL, allowing the simulator namespaces to be replaced with separate external servers seamlessly.

---

## 2. Simulated OEM API Contracts

### A. Voltera Motors (`/oem/voltera`)
- **Authentication**: OAuth 2.0 Bearer token issuance.
  - `POST /oauth/token`: Generates token with `{ access_token, token_type: "Bearer", expires_in: 3600 }`.
  - Rejects invalid credentials with HTTP 401.
- **Vehicle Discovery**:
  - `GET /v1/vehicles?page=1&limit=5`: Paginated vehicle list with `page`, `limit`, `total`, `total_pages`, and `has_more`.
- **Access Verification**:
  - `POST /v1/vehicles/verify-access`: Body `{ vehicle_ids: string[] }`.
- **Latest Telemetry**:
  - `GET /v1/vehicles/:id/telemetry/latest`: Returns latest available vehicle sample.
- **Incremental Historical Telemetry**:
  - `GET /v1/vehicles/:id/telemetry/history?cursor=...&limit=10&since=...`: Supports sequence-based cursor pagination.
- **Health Check**:
  - `GET /health`: Returns service health or 401 if credentials are revoked.

### B. Crestline Automotive (`/oem/crestline`)
- **Authentication**: API key header validation (`X-API-Key`).
- **Vehicle Discovery**:
  - `GET /v1/fleet/vehicles?cursor=...&limit=5`: Cursor-paginated vehicle inventory.
- **Latest Feed**:
  - `GET /v1/vehicles/:id/feed`: Current state with velocity, distance, ignition, and battery.
- **Incremental History**:
  - `GET /v1/vehicles/:id/history?cursor=...&limit=10`: Sequence-paginated telemetry history.
- **Webhook Subscriptions**:
  - `POST /v1/webhooks/subscriptions`: Registers webhook receiver URL and shared HMAC secret.
  - `DELETE /v1/webhooks/subscriptions/:id`: Cancels active subscription.
  - Emits telemetry events with `X-Signature-SHA256` HMAC-SHA256 header.

### C. Navarro Commercial Vehicles (`/oem/navarro`)
- **Authentication**: Commercial OAuth token.
- **Discovery & Telemetry**:
  - `GET /v1/vehicles`: Discovers commercial haulers.
  - `GET /v1/vehicles/:id/telemetry`: Telemetry with cargo weight, temperature zones, and hours.

---

## 3. Continuous Kinematics & Physics Engine

1. **Route-Following Navigation**: Vehicles move along realistic road fixtures with bends and intersections.
2. **Speed & Acceleration Constraints**: Respects physical acceleration limits (max 2.5 m/s² ~ 9 km/h/s) and braking limits (max 4.5 m/s² ~ 16 km/h/s).
3. **Continuous State Transitions**:
   - `MOVING`: Dynamic speed, consuming battery/fuel according to velocity.
   - `IDLE`: Stationary with ignition ON, low idle consumption.
   - `PARKED`: Stationary with ignition OFF, zero consumption.
   - `CHARGING`: Stationary with ignition OFF, battery SOC increases gradually up to 100%.
4. **Odometer Integration**: Distance traveled calculated accurately from elapsed simulation time.
5. **Decoupled Telemetry Sampling**: Internal physics advance continuously (default 1s interval), while OEM telemetry events are sampled at OEM-specific cadences (Voltera every 3s, Crestline every 4s, Navarro every 5s).
6. **Reproducibility**: Seeded PRNG ensures scenario repeatability.

---

## 4. Controlled Failure Scenarios

Toggled via the frontend Simulator Control panel or `POST /api/simulator/scenarios`:

| Scenario ID | Name | Description |
|---|---|---|
| `expired_auth` | Expired Credentials | OEM endpoints return HTTP 401 Unauthorized until reauthorized. |
| `rate_limit` | Rate Limiting (429) | OEM endpoints return HTTP 429 Too Many Requests with `Retry-After: 5`. |
| `transient_5xx` | Transient Server Errors | OEM endpoints return HTTP 503 Service Unavailable. |
| `duplicate_delivery` | Duplicate Delivery | Sends duplicate event IDs across webhooks or history queries. |
| `delayed_out_of_order` | Out-of-Order Telemetry | Returns history events in reversed sequence. |
| `missing_gps` | Missing GPS Samples | Omits latitude and longitude from telemetry samples. |
| `gps_noise` | GPS Noise | Adds significant artificial coordinate drift. |
| `invalid_sensor_value` | Invalid Sensor Values | Sends string or out-of-range values for speed and SOC. |
| `breaking_schema` | Breaking OEM Format | Emits unmapped `telemetry_v3` format, triggering quarantine and replay recovery. |
| `delivery_outage` | Delivery Outage | Vehicles continue moving, but network delivery halts until catch-up. |

---

## 5. Startup Commands

### Run Both Systems Concurrently

**Terminal 1: Platform Backend (Port 3001)**
```bash
cd backend
npm run dev
```

**Terminal 2: OEM Simulation Server (Port 3002)**
```bash
cd backend
npm run simulator
```

**Terminal 3: Fleet Manager Frontend (Port 5173)**
```bash
cd frontend
npm run dev
```

### Run Tests

Run the complete test suite including the end-to-end simulator verification:
```bash
cd backend
npm test
```

---

## 6. Configuration Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Platform backend HTTP port |
| `SIMULATOR_PORT` | `3002` | OEM simulator HTTP port |
| `DB_PATH` | `data/zspeed.db` | Platform SQLite database path |
| `SIMULATOR_DB_PATH` | `data/simulator.db` | Simulator SQLite database path |
| `VOLTERA_BASE_URL` | `http://127.0.0.1:3002/oem/voltera` | Voltera OEM API base URL |
| `CRESTLINE_BASE_URL` | `http://127.0.0.1:3002/oem/crestline` | Crestline OEM API base URL |
| `NAVARRO_BASE_URL` | `http://127.0.0.1:3002/oem/navarro` | Navarro OEM API base URL |

---

## 7. Current Simplifications

1. **Colocated OEM Namespaces**: Fictional OEMs run inside a single Express process partitioned by namespaces (`/oem/voltera`, `/oem/crestline`, `/oem/navarro`). Connectors use individual base URLs so these can be split into separate hostnames in production without code changes.
2. **Local SQLite Persistence**: SQLite with WAL mode is used for both platform and simulator storage, keeping the prototype fully self-contained and free of external database dependencies.
