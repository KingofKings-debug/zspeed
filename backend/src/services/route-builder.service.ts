import type { GpsPoint } from "./trip-builder.service.js";

export interface RoutePoint {
  lat: number;
  lon: number;
  eventId: string;
  eventTime: string;
  isEventMarker: boolean;
  eventType?: string;
}

export interface SimplifiedRoute {
  type: "FeatureCollection";
  features: any[];
}

const RDP_EPSILON = 0.00005;

function perpendicularDistance(
  point: RoutePoint,
  lineStart: RoutePoint,
  lineEnd: RoutePoint
): number {
  const dx = lineEnd.lon - lineStart.lon;
  const dy = lineEnd.lat - lineStart.lat;

  if (dx === 0 && dy === 0) {
    return Math.sqrt(
      Math.pow(point.lat - lineStart.lat, 2) + Math.pow(point.lon - lineStart.lon, 2)
    );
  }

  const t =
    ((point.lon - lineStart.lon) * dx + (point.lat - lineStart.lat) * dy) /
    (dx * dx + dy * dy);

  const closestLon = lineStart.lon + t * dx;
  const closestLat = lineStart.lat + t * dy;

  return Math.sqrt(
    Math.pow(point.lat - closestLat, 2) + Math.pow(point.lon - closestLon, 2)
  );
}

function rdpSimplify(points: RoutePoint[], epsilon: number): RoutePoint[] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [points[0], points[points.length - 1]];
}

export function buildRoutePoints(
  points: GpsPoint[],
  eventMarkers: Set<string>
): RoutePoint[] {
  return points
    .filter((p) => !p.qualityFlags.includes("IMPLAUSIBLE_GPS_JUMP"))
    .map((p) => ({
      lat: p.lat,
      lon: p.lon,
      eventId: p.eventId,
      eventTime: p.eventTime.toISOString(),
      isEventMarker: eventMarkers.has(p.eventId),
      eventType: undefined,
    }));
}

export function simplifyRoute(
  points: RoutePoint[],
  epsilon: number = RDP_EPSILON
): RoutePoint[] {
  if (points.length <= 2) return points;

  const markerIndices = new Set<number>();
  for (let i = 0; i < points.length; i++) {
    if (points[i].isEventMarker) {
      markerIndices.add(i);
    }
  }

  if (markerIndices.size === 0) {
    return rdpSimplify(points, epsilon);
  }

  const markerIdxSorted = Array.from(markerIndices).sort((a, b) => a - b);
  const segmentBoundaries = [0, ...markerIdxSorted, points.length - 1];
  const uniqueBoundaries = [...new Set(segmentBoundaries)].sort((a, b) => a - b);

  const result: RoutePoint[] = [];
  for (let s = 0; s < uniqueBoundaries.length - 1; s++) {
    const from = uniqueBoundaries[s];
    const to = uniqueBoundaries[s + 1];
    const segment = points.slice(from, to + 1);
    const simplified = rdpSimplify(segment, epsilon);
    if (s === 0) {
      result.push(...simplified);
    } else {
      result.push(...simplified.slice(1));
    }
  }
  return result;
}

export function detectRouteGaps(
  allPoints: GpsPoint[],
  routePoints: RoutePoint[]
): { gapBefore: string; gapAfter: string }[] {
  const gaps: { gapBefore: string; gapAfter: string }[] = [];
  const implausible = allPoints.filter((p) => p.qualityFlags.includes("IMPLAUSIBLE_GPS_JUMP"));

  for (const jump of implausible) {
    const idx = allPoints.findIndex((p) => p.eventId === jump.eventId);
    if (idx > 0) {
      gaps.push({
        gapBefore: allPoints[idx - 1].eventId,
        gapAfter: jump.eventId,
      });
    }
  }
  return gaps;
}

export function buildGeoJsonRoute(
  routePoints: RoutePoint[],
  gaps: { gapBefore: string; gapAfter: string }[]
): SimplifiedRoute {
  if (routePoints.length === 0) {
    return { type: "FeatureCollection", features: [] };
  }

  const gapAfterIds = new Set(gaps.map((g) => g.gapAfter));

  const segments: RoutePoint[][] = [];
  let current: RoutePoint[] = [];

  for (let i = 0; i < routePoints.length; i++) {
    const p = routePoints[i];
    if (gapAfterIds.has(p.eventId) && current.length > 0) {
      segments.push(current);
      current = [p];
    } else {
      current.push(p);
    }
  }
  if (current.length > 0) segments.push(current);

  const features: any[] = [];

  for (const segment of segments) {
    if (segment.length < 2) continue;
    features.push({
      type: "Feature",
      properties: {
        type: "route_segment",
        point_count: segment.length,
      },
      geometry: {
        type: "LineString",
        coordinates: segment.map((p) => [p.lon, p.lat]),
      },
    });
  }

  return { type: "FeatureCollection", features };
}

export function buildBoundingBox(points: RoutePoint[]): [number, number, number, number] | null {
  if (points.length === 0) return null;
  let minLon = points[0].lon;
  let maxLon = points[0].lon;
  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  for (const p of points) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}
