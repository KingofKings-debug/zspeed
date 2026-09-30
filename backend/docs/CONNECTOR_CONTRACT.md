# OEM Connector Contract & Integration Architecture

## Overview

The `OemConnectorContract` establishes a standard interface for integrating external vehicle telematics platforms into the zspeed connected-vehicle platform. All OEM adapters follow a unified lifecycle: authorization, discovery, vehicle access verification, stream activation, health monitoring, and graceful disconnection.

Fictional OEM connectors (such as Voltera, Crestline, and Navarro) are explicitly identified as **DEMO connectors** (`isDemo: true`). Production connectors implement the same lifecycle contract and feed telemetry through the unified ingestion entry point.

---

## Contract Interface Specification

```typescript
export interface OemConnectorContract {
  readonly oemId: string;
  readonly name: string;
  readonly isDemo: boolean;

  authorize(credentials: Record<string, string>): Promise<{
    success: boolean;
    accountId?: string;
    secretRef?: string;
    error?: string;
  }>;

  discoverVehicles(accountId: string): Promise<OemDiscoveredVehicle[]>;

  verifyAccess(
    accountId: string,
    vehicleIds: string[]
  ): Promise<{ vehicleId: string; accessible: boolean }[]>;

  activate(
    connectionId: string,
    fleetId: string,
    mappedVehicles: { oem_vehicle_id: string; vin: string }[]
  ): Promise<boolean>;

  disconnect(connectionId: string): Promise<boolean>;

  reconnect(
    connectionId: string,
    credentials?: Record<string, string>
  ): Promise<{ success: boolean; error?: string }>;

  checkHealth(connectionId: string): Promise<{
    healthy: boolean;
    message: string;
    expired?: boolean;
  }>;

  startDelivery?(
    connectionId: string,
    fleetId: string,
    onEvent: (sourceVehicleId: string, payload: any) => Promise<any> | any
  ): void;

  stopDelivery?(connectionId: string): void;
}
```

---

## Lifecycle Stages

### 1. Authorization
- Validates supplied credentials against the provider API or OAuth token endpoint.
- Sensitive credentials (passwords, client secrets, API tokens) are encrypted in the credential vault and referenced solely by an opaque `secretRef` (`sec_<uuid>`).
- Credentials are automatically redacted in application logs and API responses.
- Failed credentials return an actionable error with connection status `NOT_CONFIGURED`.

### 2. Vehicle Discovery & Verification
- `discoverVehicles` returns all vehicles associated with the fleet account.
- `verifyAccess` evaluates vehicle-level scopes and consent before mapping.
- Unverified or inaccessible vehicles are assigned status `UNAUTHORISED_VEHICLE`.

### 3. Activation & Ingestion Delivery
- Activating a connection sets vehicles to `AWAITING_DATA`. No telemetry is fabricated upon wizard completion.
- Telemetry freshness (`last_data_at` and `RECEIVING` status) is updated strictly when a valid observation is processed by the ingestion engine.
- For demo connectors, a background delivery service dispatches realistic raw payloads to `ingestEvent()`.
- Production adapters register webhooks or schedule incremental polling tasks targeting the identical `ingestEvent()` entry point.

### 4. Health & Reauthorization
- Periodic health checks determine connection status: `ACTIVE`, `DEGRADED`, or `EXPIRED`.
- When an access token expires or authorization is revoked, connection status transitions to `EXPIRED` with an actionable message.
- Reconnection supports using either the stored `secretRef` or newly submitted credentials.

### 5. Disconnection
- Calling `disconnect` halts background delivery, tears down webhook subscriptions, and sets connection status to `DISCONNECTED`.
- Associated vehicles transition to `NO_CONNECTION`.

---

## Unsupported OEMs

The connector registry (`isConnectorAvailable(oemId)`) detects whether an adapter exists for a given manufacturer. If an OEM is registered in the database without an active connector:
- The UI presents the manufacturer as **"Integration unavailable / Request integration"**.
- Connection attempts return a 400 validation error directing the manager to submit an integration request.

---

## Concrete Production Adapter Example

The following reference implementation shows a polling-based adapter adhering to `OemConnectorContract`:

```typescript
import type { OemConnectorContract } from "./types.js";
import type { OemDiscoveredVehicle } from "../types.js";
import { storeSecret, getSecret } from "../services/vault.service.js";

export class SampleRestOemAdapter implements OemConnectorContract {
  readonly oemId = "oem_sample_telematics";
  readonly name = "Sample Telematics Provider";
  readonly isDemo = false;

  private pollIntervals = new Map<string, NodeJS.Timeout>();

  async authorize(credentials: Record<string, string>): Promise<{
    success: boolean;
    accountId?: string;
    secretRef?: string;
    error?: string;
  }> {
    if (!credentials.clientId || !credentials.clientSecret) {
      return { success: false, error: "Missing required client credentials." };
    }

    try {
      const response = await fetch("https://api.sample-telematics.example/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
      });

      if (!response.ok) {
        return { success: false, error: "Invalid client credentials provided." };
      }

      const data = await response.json();
      const secretRef = storeSecret({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      });

      return {
        success: true,
        accountId: data.account_id || `acct_${credentials.clientId}`,
        secretRef,
      };
    } catch (err: any) {
      return { success: false, error: `Connection failed: ${err.message}` };
    }
  }

  async discoverVehicles(accountId: string): Promise<OemDiscoveredVehicle[]> {
    return [];
  }

  async verifyAccess(
    accountId: string,
    vehicleIds: string[]
  ): Promise<{ vehicleId: string; accessible: boolean }[]> {
    return vehicleIds.map((id) => ({ vehicleId: id, accessible: true }));
  }

  async activate(
    connectionId: string,
    fleetId: string,
    mappedVehicles: { oem_vehicle_id: string; vin: string }[]
  ): Promise<boolean> {
    return true;
  }

  async disconnect(connectionId: string): Promise<boolean> {
    const timer = this.pollIntervals.get(connectionId);
    if (timer) {
      clearInterval(timer);
      this.pollIntervals.delete(connectionId);
    }
    return true;
  }

  async reconnect(
    connectionId: string,
    credentials?: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  async checkHealth(connectionId: string): Promise<{
    healthy: boolean;
    message: string;
    expired?: boolean;
  }> {
    return { healthy: true, message: "Service operational" };
  }
}
```
