export interface SimVehicle {
  id: string;
  oem_id: string;
  vin: string;
  make: string;
  model: string;
  year: number;
  route_index: number;
  route_progress: number;
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
  speed: number;
  target_speed: number;
  acceleration: number;
  odometer: number;
  soc: number;
  fuel_level: number;
  ignition: string;
  charging: number;
  fault_code: string | null;
  status: string;
  updated_at: string;
  sample_seq?: number;
  sample_timestamp?: string;
}

export interface SimStatus {
  running: boolean;
  paused: boolean;
  seed: number;
  speedMultiplier: number;
  vehicleCount: number;
  runId: string;
  elapsedSimSeconds: number;
  simTimeMs: number;
}

export interface SimScenario {
  enabled: boolean;
  config: Record<string, any>;
}

export type SimMetrics = Record<string, number>;
