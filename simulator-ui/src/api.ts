import type { SimStatus, SimVehicle, SimMetrics, SimScenario } from "./types";

const SIM_API_BASE = (((import.meta as any).env?.VITE_SIMULATOR_URL as string) || "").replace(/\/$/, "");

const SIM_ADMIN_KEY = (((import.meta as any).env?.VITE_SIMULATOR_ADMIN_KEY as string) || "sim-admin-secret-2026");

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${SIM_API_BASE}/api/simulator${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Simulator-Admin-Key": SIM_ADMIN_KEY,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    let errMessage = `HTTP ${res.status}: ${res.statusText}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) errMessage = parsed.error;
    } catch {}
    throw new Error(errMessage);
  }

  return res.json();
}

export const simulatorApi = {
  getStatus(): Promise<SimStatus & { scenarios: Record<string, SimScenario>; metrics: SimMetrics }> {
    return request("/status");
  },

  start(): Promise<{ success: boolean; status: SimStatus }> {
    return request("/start", { method: "POST" });
  },

  pause(): Promise<{ success: boolean; status: SimStatus }> {
    return request("/pause", { method: "POST" });
  },

  resume(): Promise<{ success: boolean; status: SimStatus }> {
    return request("/resume", { method: "POST" });
  },

  stop(): Promise<{ success: boolean; status: SimStatus }> {
    return request("/stop", { method: "POST" });
  },

  reset(seed: number, vehicle_count: number, speed_multiplier: number): Promise<{ success: boolean; status: SimStatus }> {
    return request("/reset", {
      method: "POST",
      body: JSON.stringify({ seed, vehicle_count, speed_multiplier }),
    });
  },

  setSpeed(speed_multiplier: number): Promise<{ success: boolean; speedMultiplier: number; status: SimStatus }> {
    return request("/speed", {
      method: "POST",
      body: JSON.stringify({ speed_multiplier }),
    });
  },

  getScenarios(): Promise<{ scenarios: Record<string, SimScenario> }> {
    return request("/scenarios");
  },

  setScenario(scenario: string, enabled: boolean, config: Record<string, any> = {}): Promise<{ success: boolean }> {
    return request("/scenarios", {
      method: "POST",
      body: JSON.stringify({ scenario, enabled, config }),
    });
  },

  getMetrics(): Promise<{ metrics: SimMetrics }> {
    return request("/metrics");
  },

  getVehicles(): Promise<{ vehicles: SimVehicle[] }> {
    return request("/vehicles");
  },
};
