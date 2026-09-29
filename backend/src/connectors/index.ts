import type { OemConnectorInterface, OemDiscoveredVehicle } from "../types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class VolteraConnector implements OemConnectorInterface {
  oemId = "oem_voltera";

  async authorize(credentials: Record<string, string>): Promise<{ success: boolean; accountId: string; error?: string }> {
    await delay(1200);
    if (credentials.username === "fail" || credentials.password === "fail") {
      return { success: false, accountId: "", error: "Invalid credentials. Check your Voltera fleet portal login." };
    }
    return { success: true, accountId: `voltera_acct_${Date.now()}` };
  }

  async discoverVehicles(accountId: string): Promise<OemDiscoveredVehicle[]> {
    await delay(800);
    return [
      { oem_vehicle_id: "VLT-001", vin: "1VXMA82635D100001", model: "Voltera e-Transit", year: 2024, available_categories: ["location", "fuel_level", "odometer", "engine_status", "tire_pressure", "battery_voltage"] },
      { oem_vehicle_id: "VLT-002", vin: "1VXMA82635D100002", model: "Voltera e-Transit", year: 2024, available_categories: ["location", "fuel_level", "odometer", "engine_status"] },
      { oem_vehicle_id: "VLT-003", vin: "1VXMA82635D100003", model: "Voltera Cargo Max", year: 2025, available_categories: ["location", "fuel_level", "odometer", "engine_status", "tire_pressure", "battery_voltage"] },
      { oem_vehicle_id: "VLT-004", vin: "1VXMA82635D100099", model: "Voltera Cargo Max", year: 2025, available_categories: ["location", "odometer"] },
    ];
  }

  getAvailableCategories(): string[] {
    return ["location", "fuel_level", "odometer", "engine_status", "tire_pressure", "battery_voltage"];
  }

  async verifyAccess(accountId: string, vehicleIds: string[]): Promise<{ vehicleId: string; accessible: boolean }[]> {
    await delay(600);
    return vehicleIds.map((vehicleId) => ({
      vehicleId,
      accessible: vehicleId !== "VLT-004",
    }));
  }

  async activate(_connectionId: string): Promise<boolean> {
    await delay(500);
    return true;
  }

  async checkHealth(_connectionId: string): Promise<{ healthy: boolean; message: string }> {
    await delay(300);
    return { healthy: true, message: "All systems operational" };
  }

  async disconnect(_connectionId: string): Promise<boolean> {
    await delay(400);
    return true;
  }

  async reconnect(_connectionId: string): Promise<boolean> {
    await delay(800);
    return true;
  }
}

class CrestlineConnector implements OemConnectorInterface {
  oemId = "oem_crestline";

  async authorize(credentials: Record<string, string>): Promise<{ success: boolean; accountId: string; error?: string }> {
    await delay(1000);
    if (!credentials.api_key || credentials.api_key === "fail") {
      return { success: false, accountId: "", error: "Invalid API key. Generate a new key in your Crestline dealer portal." };
    }
    return { success: true, accountId: `crestline_acct_${Date.now()}` };
  }

  async discoverVehicles(accountId: string): Promise<OemDiscoveredVehicle[]> {
    await delay(900);
    return [
      { oem_vehicle_id: "CRS-001", vin: "2CRST96748E200001", model: "Crestline Accord EV", year: 2024, available_categories: ["location", "odometer", "engine_status", "diagnostics", "door_status"] },
      { oem_vehicle_id: "CRS-002", vin: "2CRST96748E200002", model: "Crestline Accord EV", year: 2024, available_categories: ["location", "odometer", "engine_status", "diagnostics"] },
      { oem_vehicle_id: "CRS-003", vin: "2CRST96748E200099", model: "Crestline Horizon", year: 2025, available_categories: ["location", "odometer"] },
    ];
  }

  getAvailableCategories(): string[] {
    return ["location", "odometer", "engine_status", "diagnostics", "door_status"];
  }

  async verifyAccess(accountId: string, vehicleIds: string[]): Promise<{ vehicleId: string; accessible: boolean }[]> {
    await delay(500);
    return vehicleIds.map((vehicleId) => ({
      vehicleId,
      accessible: true,
    }));
  }

  async activate(_connectionId: string): Promise<boolean> {
    await delay(400);
    return true;
  }

  async checkHealth(_connectionId: string): Promise<{ healthy: boolean; message: string }> {
    await delay(200);
    return { healthy: true, message: "API connection stable" };
  }

  async disconnect(_connectionId: string): Promise<boolean> {
    await delay(300);
    return true;
  }

  async reconnect(_connectionId: string): Promise<boolean> {
    await delay(700);
    return true;
  }
}

class NavarroConnector implements OemConnectorInterface {
  oemId = "oem_navarro";

  async authorize(credentials: Record<string, string>): Promise<{ success: boolean; accountId: string; error?: string }> {
    await delay(1500);
    if (credentials.username === "fail") {
      return { success: false, accountId: "", error: "Authentication failed. Verify your Navarro fleet management credentials." };
    }
    return { success: true, accountId: `navarro_acct_${Date.now()}` };
  }

  async discoverVehicles(accountId: string): Promise<OemDiscoveredVehicle[]> {
    await delay(1100);
    return [
      { oem_vehicle_id: "NAV-001", vin: "3NAVR11859F300001", model: "Navarro Hauler 5000", year: 2024, available_categories: ["location", "fuel_level", "odometer", "cargo_weight", "temperature_zone", "driver_hours"] },
      { oem_vehicle_id: "NAV-002", vin: "3NAVR11859F300002", model: "Navarro Hauler 5000", year: 2024, available_categories: ["location", "fuel_level", "odometer", "cargo_weight", "driver_hours"] },
      { oem_vehicle_id: "NAV-003", vin: "3NAVR11859F300003", model: "Navarro Hauler 3000", year: 2025, available_categories: ["location", "fuel_level", "odometer", "cargo_weight", "temperature_zone"] },
    ];
  }

  getAvailableCategories(): string[] {
    return ["location", "fuel_level", "odometer", "cargo_weight", "temperature_zone", "driver_hours"];
  }

  async verifyAccess(accountId: string, vehicleIds: string[]): Promise<{ vehicleId: string; accessible: boolean }[]> {
    await delay(700);
    return vehicleIds.map((vehicleId) => ({
      vehicleId,
      accessible: true,
    }));
  }

  async activate(_connectionId: string): Promise<boolean> {
    await delay(600);
    return true;
  }

  async checkHealth(_connectionId: string): Promise<{ healthy: boolean; message: string }> {
    await delay(250);
    const isHealthy = Math.random() > 0.1;
    return {
      healthy: isHealthy,
      message: isHealthy ? "Telemetry feed active" : "Intermittent connectivity to Navarro gateway",
    };
  }

  async disconnect(_connectionId: string): Promise<boolean> {
    await delay(500);
    return true;
  }

  async reconnect(_connectionId: string): Promise<boolean> {
    await delay(1000);
    return true;
  }
}

const connectors: Map<string, OemConnectorInterface> = new Map();
connectors.set("oem_voltera", new VolteraConnector());
connectors.set("oem_crestline", new CrestlineConnector());
connectors.set("oem_navarro", new NavarroConnector());

export function getConnector(oemId: string): OemConnectorInterface | undefined {
  return connectors.get(oemId);
}

export function getAllConnectorIds(): string[] {
  return Array.from(connectors.keys());
}
