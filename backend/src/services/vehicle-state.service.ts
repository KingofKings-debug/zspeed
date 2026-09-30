export type VehicleLiveState =
  | "CONNECTED"
  | "DATA_RECENT"
  | "MOVING"
  | "IDLE"
  | "OFFLINE"
  | "STALE";

export type MovementState = "MOVING" | "IDLE" | "PARKED" | "CHARGING";
export type DataFreshness = "LIVE" | "STALE" | "OFFLINE" | "AWAITING_DATA";

export const STALE_TIMEOUT_MS = 60 * 1000;
export const OFFLINE_TIMEOUT_MS = 300 * 1000;
export const MOVEMENT_SPEED_THRESHOLD_KMH = 0.5;

export interface VehicleStateEvaluationInput {
  hasActiveConnection: boolean;
  lastReceiptTime?: Date | string | null;
  sourceEventTime?: Date | string | null;
  speed?: number | null;
  ignition?: string | null;
  charging?: boolean | number | null;
  now?: Date;
}

export function computeMovementState(
  speed?: number | null,
  ignition?: string | null,
  charging?: boolean | number | null
): MovementState {
  if (charging) {
    return "CHARGING";
  }
  const isIgnitionOff = ignition && String(ignition).trim().toLowerCase() === "off";
  const numSpeed = speed !== null && speed !== undefined ? Number(speed) : null;
  if (isIgnitionOff) {
    return "PARKED";
  }
  if (numSpeed !== null && numSpeed > MOVEMENT_SPEED_THRESHOLD_KMH) {
    return "MOVING";
  }
  return "IDLE";
}

export function computeDataFreshness(params: {
  hasActiveConnection: boolean;
  lastReceiptTime?: Date | string | null;
  now?: Date;
}): DataFreshness {
  if (!params.hasActiveConnection) {
    return "OFFLINE";
  }
  if (!params.lastReceiptTime) {
    return "AWAITING_DATA";
  }
  const now = params.now || new Date();
  const d = typeof params.lastReceiptTime === "string" ? new Date(params.lastReceiptTime) : params.lastReceiptTime;
  const ageMs = now.getTime() - d.getTime();
  if (isNaN(ageMs) || ageMs > OFFLINE_TIMEOUT_MS) {
    return "OFFLINE";
  }
  if (ageMs > STALE_TIMEOUT_MS) {
    return "STALE";
  }
  return "LIVE";
}

export function computeVehicleLiveState(params: VehicleStateEvaluationInput): VehicleLiveState {
  if (!params.hasActiveConnection) {
    return "OFFLINE";
  }

  const effectiveTime = params.lastReceiptTime || params.sourceEventTime;
  if (!effectiveTime) {
    return "CONNECTED";
  }

  const now = params.now || new Date();
  const eventDate = typeof effectiveTime === "string" ? new Date(effectiveTime) : effectiveTime;
  const ageMs = now.getTime() - eventDate.getTime();

  if (isNaN(ageMs) || ageMs > OFFLINE_TIMEOUT_MS) {
    return "OFFLINE";
  }

  if (ageMs > STALE_TIMEOUT_MS) {
    return "STALE";
  }

  const isIgnitionOff = params.ignition && String(params.ignition).trim().toLowerCase() === "off";
  const speed = params.speed !== null && params.speed !== undefined ? Number(params.speed) : null;

  if (isIgnitionOff || (speed !== null && speed <= MOVEMENT_SPEED_THRESHOLD_KMH)) {
    return "IDLE";
  }

  if (speed !== null && speed > MOVEMENT_SPEED_THRESHOLD_KMH) {
    return "MOVING";
  }

  return "DATA_RECENT";
}
