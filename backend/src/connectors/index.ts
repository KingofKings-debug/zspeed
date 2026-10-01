import type { OemDiscoveredVehicle } from "../types.js";
import type { OemConnectorContract } from "./types.js";
import { storeSecret } from "../services/vault.service.js";
import { startDemoDelivery, stopDemoDelivery } from "../services/delivery.service.js";
import { queryOne, run } from "../db/pool.js";
import crypto from "crypto";
import { getOemBaseUrl } from "./urls.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getVolteraBaseUrl(): string {
  return getOemBaseUrl("oem_voltera");
}

function getCrestlineBaseUrl(): string {
  return getOemBaseUrl("oem_crestline");
}

function getNavarroBaseUrl(): string {
  return getOemBaseUrl("oem_navarro");
}

class VolteraDemoConnector implements OemConnectorContract {
  readonly oemId = "oem_voltera";
  readonly name = "Voltera (Simulation Contract)";
  readonly isDemo = true;

  async authorize(credentials: Record<string, string>): Promise<{
    success: boolean;
    accountId?: string;
    secretRef?: string;
    error?: string;
  }> {
    const baseUrl = getVolteraBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(2000),
      });

      if (!res.ok) {
        const data = (await res.json()) as any;
        return {
          success: false,
          error: data.message || "Invalid credentials. Check your Voltera fleet portal login.",
        };
      }

      const data = (await res.json()) as any;
      const secretRef = storeSecret({ ...credentials, access_token: data.access_token });
      return {
        success: true,
        accountId: `voltera_acct_${Date.now()}`,
        secretRef,
      };
    } catch {
      await delay(100);
      if (credentials.username === "fail" || credentials.password === "fail") {
        return {
          success: false,
          error: "Invalid credentials. Check your Voltera fleet portal login.",
        };
      }
      const secretRef = storeSecret(credentials);
      return {
        success: true,
        accountId: `voltera_acct_${Date.now()}`,
        secretRef,
      };
    }
  }

  async discoverVehicles(_accountId: string): Promise<OemDiscoveredVehicle[]> {
    const baseUrl = getVolteraBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/v1/vehicles?limit=50`, {
        headers: { Authorization: "Bearer demo_valid_token" },
        signal: AbortSignal.timeout(2000),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.vehicles && Array.isArray(data.vehicles)) {
          return data.vehicles;
        }
      }
    } catch {}

    await delay(100);
    return [
      {
        oem_vehicle_id: "VLT-001",
        vin: "1VXMA82635D100001",
        model: "Voltera e-Transit",
        year: 2024,
        available_categories: ["location", "fuel_level", "odometer", "engine_status", "tire_pressure", "battery_voltage"],
      },
      {
        oem_vehicle_id: "VLT-002",
        vin: "1VXMA82635D100002",
        model: "Voltera e-Transit",
        year: 2024,
        available_categories: ["location", "fuel_level", "odometer", "engine_status"],
      },
      {
        oem_vehicle_id: "VLT-003",
        vin: "1VXMA82635D100003",
        model: "Voltera Cargo Max",
        year: 2025,
        available_categories: ["location", "fuel_level", "odometer", "engine_status", "tire_pressure", "battery_voltage"],
      },
      {
        oem_vehicle_id: "VLT-004",
        vin: "1VXMA82635D100099",
        model: "Voltera Cargo Max",
        year: 2025,
        available_categories: ["location", "odometer"],
      },
    ];
  }

  async verifyAccess(
    _accountId: string,
    vehicleIds: string[]
  ): Promise<{ vehicleId: string; accessible: boolean }[]> {
    const baseUrl = getVolteraBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/v1/vehicles/verify-access`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer demo_valid_token",
        },
        body: JSON.stringify({ vehicle_ids: vehicleIds }),
        signal: AbortSignal.timeout(2000),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.results && Array.isArray(data.results)) {
          return data.results;
        }
      }
    } catch {}

    await delay(50);
    return vehicleIds.map((vehicleId) => ({
      vehicleId,
      accessible: vehicleId !== "VLT-004",
    }));
  }

  async activate(
    connectionId: string,
    fleetId: string,
    _mappedVehicles: { oem_vehicle_id: string; vin: string }[]
  ): Promise<boolean> {
    await delay(50);
    startDemoDelivery(connectionId, fleetId, this.oemId);
    return true;
  }

  async disconnect(connectionId: string): Promise<boolean> {
    await delay(50);
    stopDemoDelivery(connectionId);
    return true;
  }

  async reconnect(
    _connectionId: string,
    credentials?: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    if (credentials) {
      return this.authorize(credentials);
    }
    return { success: true };
  }

  async checkHealth(_connectionId: string): Promise<{
    healthy: boolean;
    message: string;
    expired?: boolean;
  }> {
    const baseUrl = getVolteraBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 401) {
        return { healthy: false, expired: true, message: "Voltera credentials expired" };
      }
      if (res.ok) {
        return { healthy: true, message: "Voltera simulation feed active" };
      }
    } catch {}

    return { healthy: true, message: "Demo feed active" };
  }
}

class CrestlineDemoConnector implements OemConnectorContract {
  readonly oemId = "oem_crestline";
  readonly name = "Crestline (Simulation Contract)";
  readonly isDemo = true;

  async authorize(credentials: Record<string, string>): Promise<{
    success: boolean;
    accountId?: string;
    secretRef?: string;
    error?: string;
  }> {
    const baseUrl = getCrestlineBaseUrl();
    try {
      const apiKey = credentials.api_key || "";
      const res = await fetch(`${baseUrl}/v1/fleet/vehicles?limit=1`, {
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(2000),
      });

      if (!res.ok) {
        const data = (await res.json()) as any;
        return {
          success: false,
          error: data.message || "Invalid API key. Generate a new key in your Crestline dealer portal.",
        };
      }

      const secretRef = storeSecret(credentials);
      return {
        success: true,
        accountId: `crestline_acct_${Date.now()}`,
        secretRef,
      };
    } catch {
      await delay(100);
      if (!credentials.api_key || credentials.api_key === "fail") {
        return {
          success: false,
          error: "Invalid API key. Generate a new key in your Crestline dealer portal.",
        };
      }
      const secretRef = storeSecret(credentials);
      return {
        success: true,
        accountId: `crestline_acct_${Date.now()}`,
        secretRef,
      };
    }
  }

  async discoverVehicles(_accountId: string): Promise<OemDiscoveredVehicle[]> {
    const baseUrl = getCrestlineBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/v1/fleet/vehicles?limit=50`, {
        headers: { "X-API-Key": "crestline_live_key" },
        signal: AbortSignal.timeout(2000),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.data && Array.isArray(data.data)) {
          return data.data;
        }
      }
    } catch {}

    await delay(100);
    return [
      {
        oem_vehicle_id: "CRS-001",
        vin: "2CRST96748E200001",
        model: "Crestline Accord EV",
        year: 2024,
        available_categories: ["location", "odometer", "engine_status", "diagnostics", "door_status"],
      },
      {
        oem_vehicle_id: "CRS-002",
        vin: "2CRST96748E200002",
        model: "Crestline Accord EV",
        year: 2024,
        available_categories: ["location", "odometer", "engine_status", "diagnostics"],
      },
      {
        oem_vehicle_id: "CRS-003",
        vin: "2CRST96748E200099",
        model: "Crestline Horizon",
        year: 2025,
        available_categories: ["location", "odometer"],
      },
    ];
  }

  async verifyAccess(
    _accountId: string,
    vehicleIds: string[]
  ): Promise<{ vehicleId: string; accessible: boolean }[]> {
    return vehicleIds.map((vehicleId) => ({
      vehicleId,
      accessible: true,
    }));
  }

  async activate(
    connectionId: string,
    fleetId: string,
    _mappedVehicles: { oem_vehicle_id: string; vin: string }[]
  ): Promise<boolean> {
    const baseUrl = getCrestlineBaseUrl();
    const webhookSecret = `whsec_${crypto.randomBytes(16).toString("hex")}`;
    const platformPort = process.env.PORT || "3001";
    const targetUrl = process.env.PLATFORM_WEBHOOK_URL || `http://127.0.0.1:${platformPort}/api/ingestion/webhooks/${connectionId}`;

    try {
      const res = await fetch(`${baseUrl}/v1/webhooks/subscriptions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "crestline_live_key",
        },
        body: JSON.stringify({
          target_url: targetUrl,
          secret: webhookSecret,
          events: ["telemetry"],
        }),
        signal: AbortSignal.timeout(2000),
      });

      if (res.ok) {
        const subData = (await res.json()) as any;
        run(
          `INSERT INTO connector_webhook_subscriptions (connection_id, subscription_id, oem_id, secret)
           VALUES (?, ?, 'oem_crestline', ?)
           ON CONFLICT(connection_id) DO UPDATE SET subscription_id = ?, secret = ?`,
          [connectionId, subData.subscription_id, webhookSecret, subData.subscription_id, webhookSecret]
        );
      }
    } catch {}

    startDemoDelivery(connectionId, fleetId, this.oemId);
    return true;
  }

  async disconnect(connectionId: string): Promise<boolean> {
    const baseUrl = getCrestlineBaseUrl();
    const sub = queryOne<{ subscription_id: string }>(
      "SELECT subscription_id FROM connector_webhook_subscriptions WHERE connection_id = ?",
      [connectionId]
    );

    if (sub?.subscription_id) {
      try {
        await fetch(`${baseUrl}/v1/webhooks/subscriptions/${sub.subscription_id}`, {
          method: "DELETE",
          headers: { "X-API-Key": "crestline_live_key" },
          signal: AbortSignal.timeout(2000),
        });
      } catch {}
      run("DELETE FROM connector_webhook_subscriptions WHERE connection_id = ?", [connectionId]);
    }

    stopDemoDelivery(connectionId);
    return true;
  }

  async reconnect(
    connectionId: string,
    credentials?: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    if (credentials) {
      return this.authorize(credentials);
    }
    return { success: true };
  }

  async checkHealth(_connectionId: string): Promise<{
    healthy: boolean;
    message: string;
    expired?: boolean;
  }> {
    const baseUrl = getCrestlineBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 401) {
        return { healthy: false, expired: true, message: "Crestline API key expired or revoked" };
      }
      if (res.ok) {
        return { healthy: true, message: "Crestline simulation feed active" };
      }
    } catch {}

    return { healthy: true, message: "Demo feed active" };
  }
}

class NavarroDemoConnector implements OemConnectorContract {
  readonly oemId = "oem_navarro";
  readonly name = "Navarro (Simulation Contract)";
  readonly isDemo = true;

  async authorize(credentials: Record<string, string>): Promise<{
    success: boolean;
    accountId?: string;
    secretRef?: string;
    error?: string;
  }> {
    const baseUrl = getNavarroBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(2000),
      });

      if (!res.ok) {
        const data = (await res.json()) as any;
        return {
          success: false,
          error: data.message || "Authentication failed. Verify your Navarro fleet management credentials.",
        };
      }

      const secretRef = storeSecret(credentials);
      return {
        success: true,
        accountId: `navarro_acct_${Date.now()}`,
        secretRef,
      };
    } catch {
      await delay(100);
      if (credentials.username === "fail") {
        return {
          success: false,
          error: "Authentication failed. Verify your Navarro fleet management credentials.",
        };
      }
      const secretRef = storeSecret(credentials);
      return {
        success: true,
        accountId: `navarro_acct_${Date.now()}`,
        secretRef,
      };
    }
  }

  async discoverVehicles(_accountId: string): Promise<OemDiscoveredVehicle[]> {
    await delay(50);
    try {
      const res = await fetch(`${getNavarroBaseUrl()}/v1/vehicles`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (Array.isArray(data.vehicles)) return data.vehicles;
      }
    } catch {}
    return [
      {
        oem_vehicle_id: "NAV-001",
        vin: "3NAVR11859F300001",
        model: "Navarro Hauler 5000",
        year: 2024,
        available_categories: ["location", "fuel_level", "odometer", "cargo_weight", "temperature_zone", "driver_hours"],
      },
      {
        oem_vehicle_id: "NAV-002",
        vin: "3NAVR11859F300002",
        model: "Navarro Hauler 5000",
        year: 2024,
        available_categories: ["location", "fuel_level", "odometer", "cargo_weight", "driver_hours"],
      },
      {
        oem_vehicle_id: "NAV-003",
        vin: "3NAVR11859F300003",
        model: "Navarro Hauler 3000",
        year: 2025,
        available_categories: ["location", "fuel_level", "odometer", "cargo_weight", "temperature_zone"],
      },
    ];
  }

  async verifyAccess(
    _accountId: string,
    vehicleIds: string[]
  ): Promise<{ vehicleId: string; accessible: boolean }[]> {
    return vehicleIds.map((vehicleId) => ({
      vehicleId,
      accessible: true,
    }));
  }

  async activate(
    connectionId: string,
    fleetId: string,
    _mappedVehicles: { oem_vehicle_id: string; vin: string }[]
  ): Promise<boolean> {
    startDemoDelivery(connectionId, fleetId, this.oemId);
    return true;
  }

  async disconnect(connectionId: string): Promise<boolean> {
    stopDemoDelivery(connectionId);
    return true;
  }

  async reconnect(
    _connectionId: string,
    credentials?: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    if (credentials && credentials.username === "fail") {
      return { success: false, error: "Re-authorization failed" };
    }
    return { success: true };
  }

  async checkHealth(_connectionId: string): Promise<{
    healthy: boolean;
    message: string;
    expired?: boolean;
  }> {
    return { healthy: true, message: "Demo feed active" };
  }
}

const connectorRegistry = new Map<string, OemConnectorContract>();
connectorRegistry.set("oem_voltera", new VolteraDemoConnector());
connectorRegistry.set("oem_crestline", new CrestlineDemoConnector());
connectorRegistry.set("oem_navarro", new NavarroDemoConnector());

export function getConnector(oemId: string): OemConnectorContract | undefined {
  return connectorRegistry.get(oemId);
}

export function isConnectorAvailable(oemId: string): boolean {
  return connectorRegistry.has(oemId);
}

export function getAllConnectorIds(): string[] {
  return Array.from(connectorRegistry.keys());
}

export function registerConnector(connector: OemConnectorContract): void {
  connectorRegistry.set(connector.oemId, connector);
}

export type { OemConnectorContract };
