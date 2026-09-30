import { useState, useEffect } from "react";
import type { Vehicle, VehicleLiveState, MovementState, DataFreshness, FleetSocketMessage } from "../types";

export interface LiveVehicleEntry {
  vehicle: Vehicle;
  speed: number | null;
  speedUnit: string;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  heading: number | null;
  battery_soc: number | null;
  odometer: number | null;
  ignition: string | null;
  movementState: MovementState;
  dataFreshness: DataFreshness;
  lastDataAt: string | null;
  lastReceiptTime: string | null;
  lastUpdatedAge: string;
  sequence: number;
  breadcrumbs: [number, number][];
  latestValues: Record<string, any>;
  signalTimestamps: Record<string, string>;
}

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

type Listener = () => void;

class VehicleStore {
  private vehicles: Map<string, LiveVehicleEntry> = new Map();
  private listeners: Set<Listener> = new Set();
  private connectionState: ConnectionState = "disconnected";
  private connectionListeners: Set<(state: ConnectionState) => void> = new Set();
  private timer: any = null;

  constructor() {
    if (typeof window !== "undefined") {
      this.timer = setInterval(() => {
        this.updateAgesAndFreshness();
      }, 2000);
    }
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeConnection(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  public setConnectionState(state: ConnectionState): void {
    if (this.connectionState !== state) {
      this.connectionState = state;
      this.connectionListeners.forEach((l) => l(state));
    }
  }

  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  private formatAge(timestamp: string | null): string {
    if (!timestamp) return "Never";
    const date = new Date(timestamp);
    const diffMs = Date.now() - date.getTime();
    if (isNaN(diffMs) || diffMs < 0) return "just now";
    const sec = Math.floor(diffMs / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return date.toLocaleDateString();
  }

  private deriveMovementState(speed: number | null, ignition: string | null, charging?: boolean): MovementState {
    if (charging) return "CHARGING";
    if (ignition && String(ignition).trim().toLowerCase() === "off") return "PARKED";
    if (speed !== null && speed !== undefined && speed > 0.5) return "MOVING";
    return "IDLE";
  }

  private updateAgesAndFreshness(): void {
    let changed = false;
    const now = Date.now();

    this.vehicles.forEach((entry) => {
      const oldAge = entry.lastUpdatedAge;
      const refTime = entry.lastReceiptTime || entry.lastDataAt;
      entry.lastUpdatedAge = this.formatAge(refTime);
      if (entry.lastUpdatedAge !== oldAge) {
        changed = true;
      }

      if (refTime) {
        const ageMs = now - new Date(refTime).getTime();
        const oldFreshness = entry.dataFreshness;
        if (ageMs > 300000) {
          entry.dataFreshness = "OFFLINE";
          if (entry.vehicle.live_state !== "OFFLINE") {
            entry.vehicle.live_state = "OFFLINE";
          }
        } else if (ageMs > 60000) {
          entry.dataFreshness = "STALE";
          if (entry.vehicle.live_state !== "STALE") {
            entry.vehicle.live_state = "STALE";
          }
        } else {
          entry.dataFreshness = "LIVE";
        }
        if (entry.dataFreshness !== oldFreshness) {
          changed = true;
        }
      }
    });

    if (changed) {
      this.notify();
    }
  }

  public reset(): void {
    this.vehicles.clear();
    this.notify();
  }

  public initializeFromSnapshot(vehiclesList: any[], snapshotVersion?: number): void {
    this.initSnapshot(vehiclesList, snapshotVersion);
  }

  public initSnapshot(vehiclesList: any[], snapshotVersion?: number): void {
    if (!Array.isArray(vehiclesList)) return;

    vehiclesList.forEach((v) => {
      const existing = this.vehicles.get(v.id);
      const vals = v.latest_values || {};
      const stamps = v.signal_timestamps || {};

      if (!existing) {
        const speed = v.speed !== undefined && v.speed !== null ? Number(v.speed) : (vals.vehicle_speed !== undefined ? Number(vals.vehicle_speed) : null);
        const lat = v.latitude !== undefined && v.latitude !== null ? Number(v.latitude) : (vals.latitude !== undefined ? Number(vals.latitude) : null);
        const lon = v.longitude !== undefined && v.longitude !== null ? Number(v.longitude) : (vals.longitude !== undefined ? Number(vals.longitude) : null);
        const alt = vals.altitude !== undefined ? Number(vals.altitude) : null;
        const heading = vals.heading !== undefined ? Number(vals.heading) : null;
        const soc = v.battery_soc !== undefined && v.battery_soc !== null ? Number(v.battery_soc) : (vals.battery_soc !== undefined ? Number(vals.battery_soc) : null);
        const odo = v.odometer !== undefined && v.odometer !== null ? Number(v.odometer) : (vals.odometer !== undefined ? Number(vals.odometer) : null);
        const ign = v.ignition || vals.ignition_status || null;
        const charging = vals.charging_state === "CHARGING" || vals.charging === true;

        const movement = v.movement_state || this.deriveMovementState(speed, ign, charging);
        const freshness = v.data_freshness || (v.last_data_at ? "LIVE" : "AWAITING_DATA");
        const breadcrumbs: [number, number][] = lat && lon ? [[lon, lat]] : [];

        this.vehicles.set(v.id, {
          vehicle: v,
          speed,
          speedUnit: v.speed_unit || "km/h",
          latitude: lat,
          longitude: lon,
          altitude: alt,
          heading,
          battery_soc: soc,
          odometer: odo,
          ignition: ign,
          movementState: movement,
          dataFreshness: freshness,
          lastDataAt: v.last_data_at || null,
          lastReceiptTime: v.state_updated_at || v.last_data_at || null,
          lastUpdatedAge: this.formatAge(v.last_data_at || null),
          sequence: snapshotVersion || 0,
          breadcrumbs,
          latestValues: vals,
          signalTimestamps: stamps,
        });
      } else {
        existing.vehicle = { ...existing.vehicle, ...v };

        const isSnapshotStale =
          (snapshotVersion !== undefined && existing.sequence > 0 && snapshotVersion < existing.sequence) ||
          (existing.lastReceiptTime && v.last_data_at && new Date(existing.lastReceiptTime).getTime() > new Date(v.last_data_at).getTime());

        if (!isSnapshotStale) {
          if (v.speed !== undefined && v.speed !== null) existing.speed = Number(v.speed);
          if (v.latitude !== undefined && v.latitude !== null) existing.latitude = Number(v.latitude);
          if (v.longitude !== undefined && v.longitude !== null) existing.longitude = Number(v.longitude);
          if (v.battery_soc !== undefined && v.battery_soc !== null) existing.battery_soc = Number(v.battery_soc);
          if (v.odometer !== undefined && v.odometer !== null) existing.odometer = Number(v.odometer);
          if (v.ignition) existing.ignition = v.ignition;
          if (v.last_data_at) {
            existing.lastDataAt = v.last_data_at;
            existing.lastUpdatedAge = this.formatAge(v.last_data_at);
          }
          existing.latestValues = { ...vals, ...existing.latestValues };
          existing.signalTimestamps = { ...stamps, ...existing.signalTimestamps };
          if (snapshotVersion !== undefined && snapshotVersion >= existing.sequence) {
            existing.sequence = snapshotVersion;
          }
        }
      }
    });

    this.notify();
  }

  public applyLiveUpdate(msg: FleetSocketMessage): void {
    const vehicleId = msg.vehicleId || msg.payload?.vehicle_id;
    if (!vehicleId) return;

    const payload = msg.payload || {};
    const seq = typeof msg.sequence === "number" ? msg.sequence : 0;
    const existing = this.vehicles.get(vehicleId);

    const incomingSpeed = payload.speed !== undefined && payload.speed !== null ? Number(payload.speed) : null;
    const incomingLat = payload.latitude !== undefined && payload.latitude !== null ? Number(payload.latitude) : null;
    const incomingLon = payload.longitude !== undefined && payload.longitude !== null ? Number(payload.longitude) : null;
    const incomingAlt = payload.altitude !== undefined && payload.altitude !== null ? Number(payload.altitude) : null;
    const incomingSoc = payload.battery_soc !== undefined && payload.battery_soc !== null ? Number(payload.battery_soc) : null;
    const incomingOdo = payload.odometer !== undefined && payload.odometer !== null ? Number(payload.odometer) : null;
    const incomingIgn = payload.ignition ?? null;
    const incomingMovement = payload.movement_state || this.deriveMovementState(incomingSpeed, incomingIgn);
    const incomingFreshness = payload.data_freshness || "LIVE";
    const ts = msg.sourceEventTime || msg.serverReceivedTime || new Date().toISOString();
    const receiptTime = msg.serverReceivedTime || new Date().toISOString();

    if (!existing) {
      const breadcrumbs: [number, number][] = incomingLat && incomingLon ? [[incomingLon, incomingLat]] : [];
      this.vehicles.set(vehicleId, {
        vehicle: {
          id: vehicleId,
          fleet_id: msg.fleetId,
          vin: payload.vin || vehicleId,
          label: payload.label || null,
          suggested_manufacturer: null,
          oem_id: null,
          connection_id: null,
          data_status: "RECEIVING",
          live_state: payload.state || "MOVING",
          last_data_at: ts,
          import_batch_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        speed: incomingSpeed,
        speedUnit: payload.speed_unit || "km/h",
        latitude: incomingLat,
        longitude: incomingLon,
        altitude: incomingAlt,
        heading: payload.heading !== undefined ? Number(payload.heading) : null,
        battery_soc: incomingSoc,
        odometer: incomingOdo,
        ignition: incomingIgn,
        movementState: incomingMovement,
        dataFreshness: incomingFreshness,
        lastDataAt: ts,
        lastReceiptTime: receiptTime,
        lastUpdatedAge: "just now",
        sequence: seq,
        breadcrumbs,
        latestValues: payload.latest_values || payload.normalized || {},
        signalTimestamps: payload.signal_timestamps || {},
      });
    } else {
      if (seq > 0 && existing.sequence > 0 && seq < existing.sequence) {
        return;
      }

      if (seq >= existing.sequence) {
        existing.sequence = seq;
      }

      if (incomingSpeed !== null) {
        existing.speed = incomingSpeed;
      }
      if (payload.speed_unit) {
        existing.speedUnit = payload.speed_unit;
      }
      if (incomingLat !== null && incomingLon !== null) {
        existing.latitude = incomingLat;
        existing.longitude = incomingLon;
        existing.breadcrumbs = [...existing.breadcrumbs, [incomingLon, incomingLat]];
        if (existing.breadcrumbs.length > 200) {
          existing.breadcrumbs = existing.breadcrumbs.slice(-200);
        }
      }
      if (incomingAlt !== null) {
        existing.altitude = incomingAlt;
      }
      if (payload.heading !== undefined && payload.heading !== null) {
        existing.heading = Number(payload.heading);
      }
      if (incomingSoc !== null) {
        existing.battery_soc = incomingSoc;
      }
      if (incomingOdo !== null) {
        existing.odometer = incomingOdo;
      }
      if (incomingIgn !== null) {
        existing.ignition = incomingIgn;
      }

      existing.movementState = incomingMovement;
      existing.dataFreshness = incomingFreshness;
      existing.lastDataAt = ts;
      existing.lastReceiptTime = receiptTime;
      existing.lastUpdatedAge = "just now";
      existing.vehicle.data_status = "RECEIVING";
      existing.vehicle.last_data_at = ts;
      if (payload.state) {
        existing.vehicle.live_state = payload.state;
      }

      const mergedVals = { ...existing.latestValues, ...(payload.latest_values || payload.normalized || {}) };
      if (incomingSpeed !== null) mergedVals.vehicle_speed = incomingSpeed;
      if (incomingLat !== null) mergedVals.latitude = incomingLat;
      if (incomingLon !== null) mergedVals.longitude = incomingLon;
      if (incomingSoc !== null) mergedVals.battery_soc = incomingSoc;
      if (incomingOdo !== null) mergedVals.odometer = incomingOdo;
      if (incomingIgn !== null) mergedVals.ignition_status = incomingIgn;
      existing.latestValues = mergedVals;

      existing.signalTimestamps = { ...existing.signalTimestamps, ...(payload.signal_timestamps || {}) };
    }

    this.notify();
  }

  public getVehicle(vehicleId: string): LiveVehicleEntry | undefined {
    return this.vehicles.get(vehicleId);
  }

  public getAllVehicles(): LiveVehicleEntry[] {
    return Array.from(this.vehicles.values());
  }

  public getOverviewStats() {
    let total = this.vehicles.size;
    let receiving = 0;
    let moving = 0;
    let idle = 0;
    let parked = 0;
    let stale = 0;
    let offline = 0;
    let attention = 0;

    this.vehicles.forEach((entry) => {
      if (entry.vehicle.data_status === "RECEIVING" && entry.dataFreshness !== "OFFLINE") {
        receiving++;
      }
      if (entry.movementState === "MOVING") {
        moving++;
      } else if (entry.movementState === "IDLE") {
        idle++;
      } else if (entry.movementState === "PARKED") {
        parked++;
      }
      if (entry.dataFreshness === "STALE") {
        stale++;
      } else if (entry.dataFreshness === "OFFLINE") {
        offline++;
      }
      if (entry.battery_soc !== null && entry.battery_soc < 20) {
        attention++;
      }
    });

    return {
      total,
      receiving,
      moving,
      idle,
      parked,
      stale,
      offline,
      attention,
      no_connection: total - receiving,
    };
  }
}

export const vehicleStore = new VehicleStore();

export function useFleetVehicles(): LiveVehicleEntry[] {
  const [vehicles, setVehicles] = useState<LiveVehicleEntry[]>(() => vehicleStore.getAllVehicles());

  useEffect(() => {
    return vehicleStore.subscribe(() => {
      setVehicles(vehicleStore.getAllVehicles());
    });
  }, []);

  return vehicles;
}

export function useVehicleEntry(vehicleId: string): LiveVehicleEntry | undefined {
  const [entry, setEntry] = useState<LiveVehicleEntry | undefined>(() => vehicleStore.getVehicle(vehicleId));

  useEffect(() => {
    setEntry(vehicleStore.getVehicle(vehicleId));
    return vehicleStore.subscribe(() => {
      setEntry(vehicleStore.getVehicle(vehicleId));
    });
  }, [vehicleId]);

  return entry;
}

export function useFleetOverview() {
  const [stats, setStats] = useState(() => vehicleStore.getOverviewStats());

  useEffect(() => {
    return vehicleStore.subscribe(() => {
      setStats(vehicleStore.getOverviewStats());
    });
  }, []);

  return stats;
}

export function useConnectionStatus(): ConnectionState {
  const [status, setStatus] = useState<ConnectionState>(() => vehicleStore.getConnectionState());

  useEffect(() => {
    return vehicleStore.subscribeConnection((st) => {
      setStatus(st);
    });
  }, []);

  return status;
}
