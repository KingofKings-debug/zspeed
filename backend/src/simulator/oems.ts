import { PRNG } from "./prng.js";

export interface GpsWaypoint {
  lat: number;
  lon: number;
}

export interface SimulatedEvent {
  source_vehicle_id: string;
  source_event_id: string;
  payload: any;
}

const CITY_ROUTES: GpsWaypoint[][] = [
  [
    { lat: 51.5074, lon: -0.1278 },
    { lat: 51.5080, lon: -0.1260 },
    { lat: 51.5092, lon: -0.1235 },
    { lat: 51.5115, lon: -0.1210 },
    { lat: 51.5138, lon: -0.1190 },
    { lat: 51.5160, lon: -0.1175 },
    { lat: 51.5185, lon: -0.1148 },
    { lat: 51.5210, lon: -0.1120 },
    { lat: 51.5235, lon: -0.1095 },
    { lat: 51.5258, lon: -0.1070 },
  ],
  [
    { lat: 51.5258, lon: -0.1070 },
    { lat: 51.5240, lon: -0.1040 },
    { lat: 51.5218, lon: -0.1010 },
    { lat: 51.5195, lon: -0.0985 },
    { lat: 51.5172, lon: -0.0958 },
    { lat: 51.5148, lon: -0.0930 },
    { lat: 51.5120, lon: -0.0905 },
    { lat: 51.5095, lon: -0.0878 },
    { lat: 51.5068, lon: -0.0850 },
    { lat: 51.5040, lon: -0.0825 },
  ],
  [
    { lat: 51.5040, lon: -0.0825 },
    { lat: 51.5060, lon: -0.0855 },
    { lat: 51.5075, lon: -0.0885 },
    { lat: 51.5088, lon: -0.0915 },
    { lat: 51.5095, lon: -0.0948 },
    { lat: 51.5098, lon: -0.0982 },
    { lat: 51.5095, lon: -0.1018 },
    { lat: 51.5088, lon: -0.1055 },
    { lat: 51.5078, lon: -0.1092 },
    { lat: 51.5074, lon: -0.1130 },
  ],
];

function applyGpsDrift(prng: PRNG, lat: number, lon: number): { lat: number; lon: number } {
  return {
    lat: lat + (prng.next() - 0.5) * 0.0002,
    lon: lon + (prng.next() - 0.5) * 0.0002,
  };
}

function interpolateWaypoints(
  route: GpsWaypoint[],
  stepsPerSegment: number
): GpsWaypoint[] {
  const result: GpsWaypoint[] = [];
  for (let i = 0; i < route.length - 1; i++) {
    const start = route[i];
    const end = route[i + 1];
    for (let s = 0; s < stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      result.push({
        lat: start.lat + (end.lat - start.lat) * t,
        lon: start.lon + (end.lon - start.lon) * t,
      });
    }
  }
  result.push(route[route.length - 1]);
  return result;
}

export function generateVolteraV1Trip(
  prng: PRNG,
  vehicleId: string,
  baseTime: Date,
  routeIndex: number,
  withGpsDrift = true,
  harshBrakeAt = -1,
  faultAt = -1,
  skipGpsAt = -1
): SimulatedEvent[] {
  const route = CITY_ROUTES[routeIndex % CITY_ROUTES.length];
  const waypoints = interpolateWaypoints(route, 5);
  const events: SimulatedEvent[] = [];

  let odo = 15000 + prng.nextInt(0, 5000);
  let chargePct = prng.nextInt(50, 90);
  let speed = 0;

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const t = new Date(baseTime.getTime() + i * 60000);
    const isStart = i === 0;
    const isEnd = i === waypoints.length - 1;
    const ignition = !isEnd ? "running" : "stopped";

    const rawLat = withGpsDrift ? applyGpsDrift(prng, wp.lat, wp.lon).lat : wp.lat;
    const rawLon = withGpsDrift ? applyGpsDrift(prng, wp.lat, wp.lon).lon : wp.lon;

    if (skipGpsAt === i) {
      const payload: any = {
        timestamp: t.toISOString(),
        speed_mph: prng.nextInt(15, 45),
        charge_fraction: chargePct / 100,
        odo_miles: odo * 0.621371,
        status: ignition,
      };
      events.push({
        source_vehicle_id: vehicleId,
        source_event_id: `evt_${vehicleId}_${i}`,
        payload,
      });
      continue;
    }

    speed = isStart || isEnd ? 0 : prng.nextInt(20, 60);
    chargePct = Math.max(10, chargePct - (isEnd ? 0 : 1));
    odo += speed * (1 / 60) * 1.60934;

    const harshBrake = harshBrakeAt === i;
    const faultCode = faultAt === i ? `P${prng.nextInt(1000, 9999)}` : null;

    const payload: any = {
      timestamp: t.toISOString(),
      speed_mph: speed * 0.621371,
      charge_fraction: chargePct / 100,
      odo_miles: odo * 0.621371,
      status: ignition,
      lat: rawLat,
      lon: rawLon,
      altitude: 15 + prng.nextInt(0, 30),
      heading: prng.nextInt(0, 360),
      harsh_brake: harshBrake,
    };

    if (faultCode) payload.fault_code = faultCode;

    events.push({
      source_vehicle_id: vehicleId,
      source_event_id: `evt_${vehicleId}_${i}`,
      payload,
    });
  }

  return events;
}

export function generateCrestlineV1Trip(
  prng: PRNG,
  vehicleId: string,
  baseTime: Date,
  routeIndex: number
): SimulatedEvent[] {
  const route = CITY_ROUTES[routeIndex % CITY_ROUTES.length];
  const waypoints = interpolateWaypoints(route, 4);
  const events: SimulatedEvent[] = [];

  let odo = 25000 + prng.nextInt(0, 5000);
  let batteryPct = prng.nextInt(40, 80);

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const t = new Date(baseTime.getTime() + i * 90000);
    const gps = applyGpsDrift(prng, wp.lat, wp.lon);
    const ignition = i < waypoints.length - 1;
    const speed = ignition ? prng.nextInt(20, 80) : 0;
    odo += speed * (1.5 / 60);
    batteryPct = Math.max(15, batteryPct - 1);

    const payload: any = {
      vehicle_identifier: vehicleId,
      event_id: `evt_c_${vehicleId}_${i}`,
      time_measured: t.getTime(),
      state: {
        velocity_kmh: speed,
        distance_km: odo,
        ignition: ignition,
        battery_pct: batteryPct,
        gps_lat: gps.lat,
        gps_lon: gps.lon,
        gps_heading: prng.nextInt(0, 360),
        harsh_braking: prng.next() < 0.05,
        charging: false,
        fault: null,
      },
    };

    events.push({
      source_vehicle_id: vehicleId,
      source_event_id: `evt_c_${vehicleId}_${i}`,
      payload,
    });
  }

  return events;
}

export function generateVolteraV2BreakingPayload(
  prng: PRNG,
  vehicleId: string,
  timestamp: Date
): SimulatedEvent {
  return {
    source_vehicle_id: vehicleId,
    source_event_id: `evt_v2_break_${vehicleId}_${timestamp.getTime()}`,
    payload: {
      timestamp: timestamp.toISOString(),
      telemetry_v3: {
        speed_kph: prng.nextInt(0, 120),
        battery_percent: prng.nextInt(10, 100),
        position: {
          latitude: 51.5074 + (prng.next() - 0.5) * 0.1,
          longitude: -0.1278 + (prng.next() - 0.5) * 0.1,
        },
      },
      device_meta: {
        odometer_km: 20000 + prng.nextInt(0, 5000),
        ignition_state: "ON",
      },
    },
  };
}

export function generateIdlePeriod(
  prng: PRNG,
  vehicleId: string,
  startTime: Date,
  durationMinutes: number
): SimulatedEvent[] {
  const events: SimulatedEvent[] = [];
  const baseLat = 51.5074 + (prng.next() - 0.5) * 0.05;
  const baseLon = -0.1278 + (prng.next() - 0.5) * 0.05;

  for (let m = 0; m < durationMinutes; m += 5) {
    const t = new Date(startTime.getTime() + m * 60000);
    const gps = applyGpsDrift(prng, baseLat, baseLon);
    events.push({
      source_vehicle_id: vehicleId,
      source_event_id: `evt_idle_${vehicleId}_${m}`,
      payload: {
        timestamp: t.toISOString(),
        speed_mph: 0,
        charge_fraction: 0.75,
        odo_miles: 10000,
        status: "stopped",
        lat: gps.lat,
        lon: gps.lon,
        altitude: 15,
        heading: 0,
        harsh_brake: false,
      },
    });
  }

  return events;
}
