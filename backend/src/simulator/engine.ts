import { v4 as uuid } from "uuid";
import { PRNG } from "./prng.js";
import {
  getSimulatorDb,
  recordSimulatorMetric,
  getSimulatorScenario,
  cleanupOldSamples,
} from "./db.js";
import {
  ROUTE_FIXTURES,
  getRouteTotalDistance,
  interpolateAlongRoute,
} from "./routes-fixtures.js";
import { dispatchWebhook } from "./webhook-dispatcher.js";

export interface SimulatedVehicleState {
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
}

export class SimulationEngine {
  private runId: string = uuid();
  private seed: number = 12345;
  private prng: PRNG = new PRNG(12345);
  private status: "RUNNING" | "PAUSED" | "STOPPED" = "STOPPED";
  private speedMultiplier: number = 1.0;
  private simTimeMs: number = Date.now();
  private elapsedSimSeconds: number = 0;
  private intervalTimer: NodeJS.Timeout | null = null;
  private tickIntervalMs: number = 1000;
  private lastSampleTimes: Map<string, number> = new Map();

  constructor() {
    this.initDefaultRun();
  }

  private initDefaultRun(): void {
    const db = getSimulatorDb();
    const existingRun = db
      .prepare("SELECT * FROM sim_runs ORDER BY started_at DESC LIMIT 1")
      .get() as any;

    if (existingRun) {
      this.runId = existingRun.run_id;
      this.seed = existingRun.seed;
      this.speedMultiplier = existingRun.speed_multiplier || 1.0;
      this.prng = new PRNG(this.seed);
    } else {
      this.reset(12345, 10, 1.0);
    }
  }

  public getStatus() {
    const db = getSimulatorDb();
    const vehicleCount = (
      db.prepare("SELECT COUNT(*) as c FROM sim_vehicles").get() as any
    )?.c || 0;
    const sampleCount = (
      db.prepare("SELECT COUNT(*) as c FROM sim_samples WHERE run_id = ?").get(this.runId) as any
    )?.c || 0;

    return {
      status: this.status,
      running: this.status === "RUNNING",
      paused: this.status === "PAUSED",
      runId: this.runId,
      seed: this.seed,
      speedMultiplier: this.speedMultiplier,
      simTime: new Date(this.simTimeMs).toISOString(),
      simTimeMs: this.simTimeMs,
      elapsedSimSeconds: this.elapsedSimSeconds,
      activeVehicles: vehicleCount,
      vehicleCount,
      totalSamples: sampleCount,
    };
  }

  public setSpeedMultiplier(multiplier: number): void {
    this.speedMultiplier = Math.max(0.1, Math.min(50, multiplier));
    const db = getSimulatorDb();
    db.prepare("UPDATE sim_runs SET speed_multiplier = ? WHERE run_id = ?").run(
      this.speedMultiplier,
      this.runId
    );
  }

  public start(): void {
    if (this.status === "RUNNING") return;
    this.status = "RUNNING";
    const db = getSimulatorDb();
    db.prepare("UPDATE sim_runs SET status = 'RUNNING', updated_at = ? WHERE run_id = ?").run(
      new Date().toISOString(),
      this.runId
    );

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }

    this.intervalTimer = setInterval(() => {
      this.tick();
    }, this.tickIntervalMs);
  }

  public pause(): void {
    this.status = "PAUSED";
    const db = getSimulatorDb();
    db.prepare("UPDATE sim_runs SET status = 'PAUSED', updated_at = ? WHERE run_id = ?").run(
      new Date().toISOString(),
      this.runId
    );
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  public resume(): void {
    this.start();
  }

  public stop(): void {
    this.status = "STOPPED";
    const db = getSimulatorDb();
    db.prepare("UPDATE sim_runs SET status = 'STOPPED', updated_at = ? WHERE run_id = ?").run(
      new Date().toISOString(),
      this.runId
    );
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  public reset(seed = 12345, vehicleCount = 10, speedMultiplier = 1.0): void {
    this.stop();
    this.runId = uuid();
    this.seed = seed;
    this.prng = new PRNG(seed);
    this.speedMultiplier = speedMultiplier;
    this.simTimeMs = Date.now();
    this.elapsedSimSeconds = 0;
    this.lastSampleTimes.clear();

    const db = getSimulatorDb();
    const nowIso = new Date().toISOString();

    db.transaction(() => {
      db.prepare("DELETE FROM sim_vehicles").run();
      db.prepare("DELETE FROM sim_samples").run();

      db.prepare(`
        INSERT INTO sim_runs (run_id, seed, status, speed_multiplier, started_at, updated_at)
        VALUES (?, ?, 'STOPPED', ?, ?, ?)
      `).run(this.runId, this.seed, this.speedMultiplier, nowIso, nowIso);

      const defaultVehicles = [
        {
          id: "VLT-001",
          oem_id: "oem_voltera",
          vin: "1VXMA82635D100001",
          make: "Voltera",
          model: "e-Transit",
          year: 2024,
          route_index: 0,
          route_progress: 0,
          speed: 45,
          target_speed: 50,
          soc: 88,
          fuel_level: 90,
          ignition: "ON",
          charging: 0,
          fault_code: null,
          status: "MOVING",
        },
        {
          id: "VLT-002",
          oem_id: "oem_voltera",
          vin: "1VXMA82635D100002",
          make: "Voltera",
          model: "e-Transit",
          year: 2024,
          route_index: 1,
          route_progress: 300,
          speed: 0,
          target_speed: 0,
          soc: 72,
          fuel_level: 80,
          ignition: "ON",
          charging: 0,
          fault_code: null,
          status: "IDLE",
        },
        {
          id: "VLT-003",
          oem_id: "oem_voltera",
          vin: "1VXMA82635D100003",
          make: "Voltera",
          model: "Cargo Max",
          year: 2025,
          route_index: 2,
          route_progress: 1200,
          speed: 38,
          target_speed: 40,
          soc: 65,
          fuel_level: 70,
          ignition: "ON",
          charging: 0,
          fault_code: null,
          status: "MOVING",
        },
        {
          id: "VLT-004",
          oem_id: "oem_voltera",
          vin: "1VXMA82635D100099",
          make: "Voltera",
          model: "Cargo Max",
          year: 2025,
          route_index: 3,
          route_progress: 0,
          speed: 0,
          target_speed: 0,
          soc: 35,
          fuel_level: 40,
          ignition: "OFF",
          charging: 1,
          fault_code: null,
          status: "CHARGING",
        },
        {
          id: "CRS-001",
          oem_id: "oem_crestline",
          vin: "2CRST96748E200001",
          make: "Crestline",
          model: "Accord EV",
          year: 2024,
          route_index: 0,
          route_progress: 600,
          speed: 52,
          target_speed: 55,
          soc: 82,
          fuel_level: 85,
          ignition: "ON",
          charging: 0,
          fault_code: null,
          status: "MOVING",
        },
        {
          id: "CRS-002",
          oem_id: "oem_crestline",
          vin: "2CRST96748E200002",
          make: "Crestline",
          model: "Accord EV",
          year: 2024,
          route_index: 1,
          route_progress: 800,
          speed: 0,
          target_speed: 0,
          soc: 94,
          fuel_level: 95,
          ignition: "OFF",
          charging: 0,
          fault_code: null,
          status: "PARKED",
        },
        {
          id: "CRS-003",
          oem_id: "oem_crestline",
          vin: "2CRST96748E200099",
          make: "Crestline",
          model: "Horizon",
          year: 2025,
          route_index: 2,
          route_progress: 100,
          speed: 40,
          target_speed: 45,
          soc: 59,
          fuel_level: 60,
          ignition: "ON",
          charging: 0,
          fault_code: null,
          status: "MOVING",
        },
        {
          id: "NAV-001",
          oem_id: "oem_navarro",
          vin: "3NAVR11859F300001",
          make: "Navarro",
          model: "Hauler 5000",
          year: 2024,
          route_index: 0,
          route_progress: 1000,
          speed: 48,
          target_speed: 50,
          soc: 77,
          fuel_level: 78,
          ignition: "ON",
          charging: 0,
          fault_code: null,
          status: "MOVING",
        },
        {
          id: "NAV-002",
          oem_id: "oem_navarro",
          vin: "3NAVR11859F300002",
          make: "Navarro",
          model: "Hauler 5000",
          year: 2024,
          route_index: 1,
          route_progress: 0,
          speed: 0,
          target_speed: 0,
          soc: 85,
          fuel_level: 90,
          ignition: "ON",
          charging: 0,
          fault_code: null,
          status: "IDLE",
        },
        {
          id: "NAV-003",
          oem_id: "oem_navarro",
          vin: "3NAVR11859F300003",
          make: "Navarro",
          model: "Hauler 3000",
          year: 2025,
          route_index: 2,
          route_progress: 400,
          speed: 35,
          target_speed: 40,
          soc: 68,
          fuel_level: 70,
          ignition: "ON",
          charging: 0,
          fault_code: null,
          status: "MOVING",
        },
      ];

      const toInsert = defaultVehicles.slice(0, vehicleCount);
      const insertStmt = db.prepare(`
        INSERT INTO sim_vehicles (
          id, oem_id, vin, make, model, year,
          route_index, route_progress, lat, lon, altitude, heading,
          speed, target_speed, acceleration, odometer, soc, fuel_level,
          ignition, charging, fault_code, status, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `);

      for (const v of toInsert) {
        const route = ROUTE_FIXTURES[v.route_index % ROUTE_FIXTURES.length];
        const initialPos = interpolateAlongRoute(route, v.route_progress);

        insertStmt.run(
          v.id,
          v.oem_id,
          v.vin,
          v.make,
          v.model,
          v.year,
          v.route_index,
          v.route_progress,
          initialPos.lat,
          initialPos.lon,
          initialPos.altitude,
          initialPos.heading,
          v.speed,
          v.target_speed,
          0.0,
          15000.0 + this.prng.nextInt(0, 5000),
          v.soc,
          v.fuel_level,
          v.ignition,
          v.charging,
          v.fault_code,
          v.status,
          nowIso
        );
      }
    })();

    this.sampleTelemetry(true);
  }

  public tick(): void {
    if (this.status !== "RUNNING") return;

    const dtSeconds = (this.tickIntervalMs / 1000) * this.speedMultiplier;
    this.advancePhysics(dtSeconds);
    this.sampleTelemetry(false);
  }

  public advancePhysics(dtSeconds: number): void {
    this.elapsedSimSeconds += dtSeconds;
    this.simTimeMs += dtSeconds * 1000;

    const db = getSimulatorDb();
    const vehicles = db.prepare("SELECT * FROM sim_vehicles").all() as SimulatedVehicleState[];
    const nowIso = new Date().toISOString();

    const updateStmt = db.prepare(`
      UPDATE sim_vehicles SET
        route_progress = ?,
        lat = ?,
        lon = ?,
        altitude = ?,
        heading = ?,
        speed = ?,
        target_speed = ?,
        acceleration = ?,
        odometer = ?,
        soc = ?,
        fuel_level = ?,
        ignition = ?,
        charging = ?,
        fault_code = ?,
        status = ?,
        updated_at = ?
      WHERE id = ?
    `);

    recordSimulatorMetric("state_advancing");

    for (const v of vehicles) {
      let speed = v.speed;
      let targetSpeed = v.target_speed;
      let status = v.status;
      let ignition = v.ignition;
      let charging = v.charging;
      let soc = v.soc;
      let fuel = v.fuel_level;
      let odo = v.odometer;
      let progress = v.route_progress;
      let faultCode = v.fault_code;

      const route = ROUTE_FIXTURES[v.route_index % ROUTE_FIXTURES.length];
      const totalDist = getRouteTotalDistance(route);

      if (status === "PARKED") {
        speed = 0;
        targetSpeed = 0;
        ignition = "OFF";
        charging = 0;
      } else if (status === "CHARGING") {
        speed = 0;
        targetSpeed = 0;
        ignition = "OFF";
        charging = 1;
        soc = Math.min(100, soc + 0.15 * dtSeconds);
        if (soc >= 98 && this.prng.next() < 0.2) {
          status = "IDLE";
          charging = 0;
          ignition = "ON";
        }
      } else if (v.id === "VLT-001") {
        const cycleSec = Math.floor(this.elapsedSimSeconds) % 60;
        if (cycleSec < 12) {
          targetSpeed = 50;
          ignition = "ON";
          charging = 0;
          status = "MOVING";
        } else if (cycleSec < 26) {
          targetSpeed = 50;
          ignition = "ON";
          charging = 0;
          status = "MOVING";
        } else if (cycleSec < 36) {
          targetSpeed = 0;
          ignition = "ON";
          charging = 0;
          status = speed > 0.5 ? "MOVING" : "IDLE";
        } else if (cycleSec < 48) {
          targetSpeed = 0;
          speed = 0;
          ignition = "ON";
          charging = 0;
          status = "IDLE";
        } else {
          targetSpeed = 45;
          ignition = "ON";
          charging = 0;
          status = "MOVING";
        }

        const maxAccelKmh = 9.0 * dtSeconds;
        const maxBrakeKmh = 16.0 * dtSeconds;

        if (speed < targetSpeed) {
          speed = Math.min(targetSpeed, speed + maxAccelKmh);
        } else if (speed > targetSpeed) {
          speed = Math.max(targetSpeed, speed - maxBrakeKmh);
        }

        const distDeltaMeters = (speed / 3.6) * dtSeconds;
        progress += distDeltaMeters;
        odo += distDeltaMeters / 1000;

        soc = Math.max(5, soc - (0.001 + (speed / 100) * 0.002) * dtSeconds);
        fuel = Math.max(5, fuel - (0.001 + (speed / 100) * 0.002) * dtSeconds);

        if (progress >= totalDist) {
          progress = 0;
        }
      } else if (status === "IDLE") {
        speed = 0;
        ignition = "ON";
        charging = 0;
        soc = Math.max(5, soc - 0.0004 * dtSeconds);
        fuel = Math.max(5, fuel - 0.0003 * dtSeconds);

        if (this.prng.next() < 0.1 * dtSeconds) {
          status = "MOVING";
          targetSpeed = 30 + this.prng.nextInt(10, 40);
        }
      } else {
        status = "MOVING";
        ignition = "ON";
        charging = 0;

        if (this.prng.next() < 0.05 * dtSeconds) {
          targetSpeed = 25 + this.prng.nextInt(10, 45);
        }

        const maxAccelKmh = 9.0 * dtSeconds;
        const maxBrakeKmh = 16.0 * dtSeconds;

        if (speed < targetSpeed) {
          speed = Math.min(targetSpeed, speed + maxAccelKmh);
        } else if (speed > targetSpeed) {
          speed = Math.max(targetSpeed, speed - maxBrakeKmh);
        }

        const distDeltaMeters = (speed / 3.6) * dtSeconds;
        progress += distDeltaMeters;
        odo += distDeltaMeters / 1000;

        soc = Math.max(5, soc - (0.001 + (speed / 100) * 0.002) * dtSeconds);
        fuel = Math.max(5, fuel - (0.001 + (speed / 100) * 0.002) * dtSeconds);

        if (progress >= totalDist) {
          progress = 0;
        }

        if (this.prng.next() < 0.02 * dtSeconds) {
          status = "IDLE";
          targetSpeed = 0;
        } else if (soc < 15 && this.prng.next() < 0.1) {
          status = "CHARGING";
          targetSpeed = 0;
        }
      }

      if (faultCode && this.prng.next() < 0.01 * dtSeconds) {
        faultCode = null;
      } else if (!faultCode && this.prng.next() < 0.002 * dtSeconds) {
        faultCode = `P${this.prng.nextInt(1000, 9999)}`;
      }

      const pos = interpolateAlongRoute(route, progress);
      const accel = (speed - v.speed) / Math.max(0.1, dtSeconds);

      updateStmt.run(
        progress,
        pos.lat,
        pos.lon,
        pos.altitude,
        pos.heading,
        speed,
        targetSpeed,
        accel,
        odo,
        soc,
        fuel,
        ignition,
        charging,
        faultCode,
        status,
        nowIso,
        v.id
      );
    }
  }

  public sampleTelemetry(forceAll = false): void {
    const db = getSimulatorDb();
    const vehicles = db.prepare("SELECT * FROM sim_vehicles").all() as SimulatedVehicleState[];
    const nowIso = new Date(this.simTimeMs).toISOString();

    const insertSampleStmt = db.prepare(`
      INSERT OR REPLACE INTO sim_samples (id, run_id, oem_id, vehicle_id, sample_seq, timestamp, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const subscriptions = db
      .prepare("SELECT * FROM sim_subscriptions WHERE active = 1")
      .all() as { id: string; oem_id: string; target_url: string; secret: string }[];

    const breakingScenario = getSimulatorScenario("breaking_schema");
    const invalidScenario = getSimulatorScenario("invalid_sensor_value");
    const missingGpsScenario = getSimulatorScenario("missing_gps");
    const gpsNoiseScenario = getSimulatorScenario("gps_noise");

    for (const v of vehicles) {
      const lastTime = this.lastSampleTimes.get(v.id) || 0;
      const sampleIntervalMs = v.oem_id === "oem_voltera" ? 3000 : (v.oem_id === "oem_crestline" ? 4000 : 5000);

      if (!forceAll && this.simTimeMs - lastTime < sampleIntervalMs) {
        continue;
      }
      this.lastSampleTimes.set(v.id, this.simTimeMs);

      const seqRow = db
        .prepare("SELECT MAX(sample_seq) as max_seq FROM sim_samples WHERE run_id = ? AND vehicle_id = ?")
        .get(this.runId, v.id) as any;
      const nextSeq = (seqRow?.max_seq || 0) + 1;
      const eventId = `evt_${v.oem_id}_${v.id}_${this.runId.slice(0, 8)}_${nextSeq}`;

      let lat = v.lat;
      let lon = v.lon;
      if (gpsNoiseScenario.enabled) {
        lat += (this.prng.next() - 0.5) * 0.05;
        lon += (this.prng.next() - 0.5) * 0.05;
      }

      let payload: any = null;

      if (v.oem_id === "oem_voltera") {
        if (breakingScenario.enabled) {
          payload = {
            timestamp: nowIso,
            telemetry_v3: {
              speed_kph: Math.round(v.speed * 10) / 10,
              battery_percent: Math.round(v.soc),
              position: missingGpsScenario.enabled
                ? null
                : { latitude: lat, longitude: lon },
            },
            device_meta: {
              odometer_km: Math.round(v.odometer),
              ignition_state: v.ignition,
            },
          };
        } else {
          payload = {
            timestamp: nowIso,
            speed_mph: invalidScenario.enabled
              ? "INVALID_SPEED"
              : Math.round(v.speed * 0.621371 * 10) / 10,
            charge_fraction: invalidScenario.enabled
              ? -99
              : Math.round(v.soc) / 100,
            odo_miles: Math.round(v.odometer * 0.621371 * 10) / 10,
            status: v.ignition === "ON" ? "running" : "stopped",
            altitude: v.altitude,
            heading: v.heading,
            harsh_brake: v.acceleration < -4.0,
          };
          if (!missingGpsScenario.enabled) {
            payload.lat = lat;
            payload.lon = lon;
          }
          if (v.fault_code) {
            payload.fault_code = v.fault_code;
          }
        }
      } else if (v.oem_id === "oem_crestline") {
        payload = {
          vehicle_identifier: v.id,
          event_id: eventId,
          time_measured: this.simTimeMs,
          state: {
            velocity_kmh: invalidScenario.enabled ? "BAD_NUM" : Math.round(v.speed * 10) / 10,
            distance_km: Math.round(v.odometer * 10) / 10,
            ignition: v.ignition === "ON",
            battery_pct: Math.round(v.soc),
            gps_heading: v.heading,
            harsh_braking: v.acceleration < -4.0,
            charging: Boolean(v.charging),
            fault: v.fault_code || null,
          },
        };
        if (!missingGpsScenario.enabled) {
          payload.state.gps_lat = lat;
          payload.state.gps_lon = lon;
        }
      } else {
        payload = {
          vehicle_id: v.id,
          timestamp: nowIso,
          speed: Math.round(v.speed),
          soc: Math.round(v.soc),
          odometer: Math.round(v.odometer),
          lat: missingGpsScenario.enabled ? null : lat,
          lon: missingGpsScenario.enabled ? null : lon,
          status: v.status,
        };
      }

      insertSampleStmt.run(
        eventId,
        this.runId,
        v.oem_id,
        v.id,
        nextSeq,
        nowIso,
        JSON.stringify(payload),
        nowIso
      );

      recordSimulatorMetric("samples_generated");

      const matchingSubs = subscriptions.filter((s) => s.oem_id === v.oem_id);
      for (const sub of matchingSubs) {
        dispatchWebhook(sub, payload).catch(() => {});
      }
    }

    cleanupOldSamples(200);
  }
}

export const engine = new SimulationEngine();
