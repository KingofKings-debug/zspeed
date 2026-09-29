export interface GpsPoint {
  eventId: string;
  eventTime: Date;
  lat: number;
  lon: number;
  altitude?: number;
  heading?: number;
  speedKmh?: number;
  ignition?: string;
  harshBrake?: boolean;
  charging?: string;
  faultCode?: string;
  idleState?: string;
  qualityFlags: string[];
}

export interface TripSegment {
  startIdx: number;
  endIdx: number;
  startTime: Date;
  endTime: Date;
  points: GpsPoint[];
  hasGapBefore: boolean;
}

const MAX_SPEED_KMH_THRESHOLD = 250;
const MAX_INSTANTANEOUS_KMH = 300;
const TRIP_GAP_SECONDS = 300;
const MIN_TRIP_DISTANCE_KM = 0.05;
const STATIONARY_RADIUS_M = 5;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function instantaneousSpeedKmh(p1: GpsPoint, p2: GpsPoint): number {
  const distKm = haversineKm(p1.lat, p1.lon, p2.lat, p2.lon);
  const dtSeconds = (p2.eventTime.getTime() - p1.eventTime.getTime()) / 1000;
  if (dtSeconds <= 0) return 0;
  return (distKm / dtSeconds) * 3600;
}

export function deduplicateAndSort(points: GpsPoint[]): GpsPoint[] {
  const seen = new Set<string>();
  const unique: GpsPoint[] = [];
  for (const p of points) {
    const key = `${p.eventId}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }
  return unique.sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
}

export function filterImplausibleJumps(points: GpsPoint[]): GpsPoint[] {
  if (points.length < 2) return points;
  const result: GpsPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const instSpeed = instantaneousSpeedKmh(prev, curr);
    if (instSpeed > MAX_INSTANTANEOUS_KMH) {
      const flagged: GpsPoint = {
        ...curr,
        qualityFlags: [...curr.qualityFlags, "IMPLAUSIBLE_GPS_JUMP"],
      };
      result.push(flagged);
    } else {
      result.push(curr);
    }
  }
  return result;
}

export function segmentIntoTrips(points: GpsPoint[]): TripSegment[] {
  if (points.length === 0) return [];

  const sorted = deduplicateAndSort(points);
  const filtered = filterImplausibleJumps(sorted);

  const hasIgnition = filtered.some((p) => p.ignition !== undefined && p.ignition !== null);

  if (hasIgnition) {
    return segmentByIgnition(filtered);
  }
  return segmentByTimeGap(filtered);
}

function segmentByIgnition(points: GpsPoint[]): TripSegment[] {
  const segments: TripSegment[] = [];
  let tripPoints: GpsPoint[] = [];
  let inTrip = false;
  let gapBefore = false;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const ignOn = p.ignition === "ON";

    if (!inTrip && ignOn) {
      inTrip = true;
      gapBefore = i > 0;
      tripPoints = [p];
    } else if (inTrip && ignOn) {
      tripPoints.push(p);
    } else if (inTrip && !ignOn) {
      tripPoints.push(p);
      if (isViableTrip(tripPoints)) {
        segments.push({
          startIdx: 0,
          endIdx: tripPoints.length - 1,
          startTime: tripPoints[0].eventTime,
          endTime: tripPoints[tripPoints.length - 1].eventTime,
          points: tripPoints,
          hasGapBefore: gapBefore,
        });
      }
      inTrip = false;
      tripPoints = [];
    }
  }

  if (inTrip && tripPoints.length > 0 && isViableTrip(tripPoints)) {
    segments.push({
      startIdx: 0,
      endIdx: tripPoints.length - 1,
      startTime: tripPoints[0].eventTime,
      endTime: tripPoints[tripPoints.length - 1].eventTime,
      points: tripPoints,
      hasGapBefore: gapBefore,
    });
  }

  return segments;
}

function segmentByTimeGap(points: GpsPoint[]): TripSegment[] {
  if (points.length === 0) return [];

  const segments: TripSegment[] = [];
  let currentSegment: GpsPoint[] = [points[0]];
  let gapBefore = false;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const gapSeconds = (curr.eventTime.getTime() - prev.eventTime.getTime()) / 1000;

    if (gapSeconds > TRIP_GAP_SECONDS) {
      if (isViableTrip(currentSegment)) {
        segments.push({
          startIdx: 0,
          endIdx: currentSegment.length - 1,
          startTime: currentSegment[0].eventTime,
          endTime: currentSegment[currentSegment.length - 1].eventTime,
          points: currentSegment,
          hasGapBefore: gapBefore,
        });
      }
      currentSegment = [curr];
      gapBefore = true;
    } else {
      currentSegment.push(curr);
    }
  }

  if (currentSegment.length > 0 && isViableTrip(currentSegment)) {
    segments.push({
      startIdx: 0,
      endIdx: currentSegment.length - 1,
      startTime: currentSegment[0].eventTime,
      endTime: currentSegment[currentSegment.length - 1].eventTime,
      points: currentSegment,
      hasGapBefore: gapBefore,
    });
  }

  return segments;
}

function isViableTrip(points: GpsPoint[]): boolean {
  if (points.length < 2) return false;
  const dist = calculateTripDistance(points);
  return dist >= MIN_TRIP_DISTANCE_KM;
}

export function calculateTripDistance(points: GpsPoint[]): number {
  let total = 0;
  const validPoints = points.filter((p) => !p.qualityFlags.includes("IMPLAUSIBLE_GPS_JUMP"));
  for (let i = 1; i < validPoints.length; i++) {
    total += haversineKm(
      validPoints[i - 1].lat, validPoints[i - 1].lon,
      validPoints[i].lat, validPoints[i].lon
    );
  }
  return total;
}

export function calculateCompleteness(points: GpsPoint[], totalExpectedGaps: number): number {
  if (totalExpectedGaps === 0) return 100;
  const gapCount = points.filter((p) => p.qualityFlags.includes("IMPLAUSIBLE_GPS_JUMP")).length;
  const missing = Math.min(gapCount, totalExpectedGaps);
  return Math.max(0, Math.round(((totalExpectedGaps - missing) / totalExpectedGaps) * 100));
}

export function detectTripEvents(
  points: GpsPoint[],
  tripId: string
): Array<{
  event_type: string;
  event_time: string;
  latitude: number | null;
  longitude: number | null;
  severity: string;
  source_normalized_event_id: string;
  metadata: Record<string, any>;
}> {
  const events: any[] = [];
  if (points.length === 0) return events;

  const start = points[0];
  events.push({
    event_type: "TRIP_START",
    event_time: start.eventTime.toISOString(),
    latitude: start.lat,
    longitude: start.lon,
    severity: "INFO",
    source_normalized_event_id: start.eventId,
    metadata: {},
  });

  const end = points[points.length - 1];

  let idleCount = 0;
  let idleStartIdx: number | null = null;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];

    if (p.harshBrake === true || p.qualityFlags.includes("HARSH_BRAKE")) {
      events.push({
        event_type: "HARSH_BRAKE",
        event_time: p.eventTime.toISOString(),
        latitude: p.lat,
        longitude: p.lon,
        severity: "WARNING",
        source_normalized_event_id: p.eventId,
        metadata: {},
      });
    }

    if (p.faultCode && p.faultCode !== "null" && p.faultCode !== "") {
      events.push({
        event_type: "FAULT",
        event_time: p.eventTime.toISOString(),
        latitude: p.lat,
        longitude: p.lon,
        severity: "CRITICAL",
        source_normalized_event_id: p.eventId,
        metadata: { fault_code: p.faultCode },
      });
    }

    if (p.charging === "CHARGING") {
      const prev = i > 0 ? points[i - 1] : null;
      if (!prev || prev.charging !== "CHARGING") {
        events.push({
          event_type: "CHARGING",
          event_time: p.eventTime.toISOString(),
          latitude: p.lat,
          longitude: p.lon,
          severity: "INFO",
          source_normalized_event_id: p.eventId,
          metadata: {},
        });
      }
    }

    const speed = p.speedKmh ?? 0;
    if (speed < 2 && p.ignition === "ON") {
      if (idleStartIdx === null) {
        idleStartIdx = i;
        idleCount = 1;
      } else {
        idleCount++;
      }
    } else {
      if (idleStartIdx !== null && idleCount >= 5) {
        const idleStart = points[idleStartIdx];
        const idleEnd = points[i - 1];
        const idleDuration = (idleEnd.eventTime.getTime() - idleStart.eventTime.getTime()) / 1000;
        if (idleDuration >= 120) {
          events.push({
            event_type: "EXTENDED_IDLE",
            event_time: idleStart.eventTime.toISOString(),
            latitude: idleStart.lat,
            longitude: idleStart.lon,
            severity: "INFO",
            source_normalized_event_id: idleStart.eventId,
            metadata: { duration_seconds: Math.round(idleDuration) },
          });
        }
      }
      idleStartIdx = null;
      idleCount = 0;
    }
  }

  events.push({
    event_type: "TRIP_END",
    event_time: end.eventTime.toISOString(),
    latitude: end.lat,
    longitude: end.lon,
    severity: "INFO",
    source_normalized_event_id: end.eventId,
    metadata: { distance_km: calculateTripDistance(points) },
  });

  return events;
}

export function hasDataGaps(points: GpsPoint[]): boolean {
  return points.some((p) => p.qualityFlags.includes("IMPLAUSIBLE_GPS_JUMP"));
}
