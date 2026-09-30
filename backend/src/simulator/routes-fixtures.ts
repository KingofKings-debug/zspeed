export interface RouteWaypoint {
  lat: number;
  lon: number;
  altitude?: number;
}

export const ROUTE_FIXTURES: RouteWaypoint[][] = [
  [
    { lat: 51.5074, lon: -0.1278, altitude: 15 },
    { lat: 51.5080, lon: -0.1260, altitude: 15 },
    { lat: 51.5092, lon: -0.1235, altitude: 16 },
    { lat: 51.5105, lon: -0.1220, altitude: 16 },
    { lat: 51.5115, lon: -0.1210, altitude: 17 },
    { lat: 51.5126, lon: -0.1200, altitude: 17 },
    { lat: 51.5138, lon: -0.1190, altitude: 18 },
    { lat: 51.5150, lon: -0.1180, altitude: 18 },
    { lat: 51.5160, lon: -0.1175, altitude: 19 },
    { lat: 51.5173, lon: -0.1160, altitude: 20 },
    { lat: 51.5185, lon: -0.1148, altitude: 20 },
    { lat: 51.5198, lon: -0.1132, altitude: 21 },
    { lat: 51.5210, lon: -0.1120, altitude: 21 },
    { lat: 51.5222, lon: -0.1108, altitude: 22 },
    { lat: 51.5235, lon: -0.1095, altitude: 22 },
    { lat: 51.5246, lon: -0.1082, altitude: 23 },
    { lat: 51.5258, lon: -0.1070, altitude: 23 },
  ],
  [
    { lat: 51.5258, lon: -0.1070, altitude: 23 },
    { lat: 51.5248, lon: -0.1052, altitude: 22 },
    { lat: 51.5240, lon: -0.1040, altitude: 22 },
    { lat: 51.5230, lon: -0.1025, altitude: 21 },
    { lat: 51.5218, lon: -0.1010, altitude: 21 },
    { lat: 51.5207, lon: -0.0998, altitude: 20 },
    { lat: 51.5195, lon: -0.0985, altitude: 20 },
    { lat: 51.5183, lon: -0.0970, altitude: 19 },
    { lat: 51.5172, lon: -0.0958, altitude: 19 },
    { lat: 51.5160, lon: -0.0945, altitude: 18 },
    { lat: 51.5148, lon: -0.0930, altitude: 18 },
    { lat: 51.5134, lon: -0.0918, altitude: 17 },
    { lat: 51.5120, lon: -0.0905, altitude: 17 },
    { lat: 51.5108, lon: -0.0892, altitude: 16 },
    { lat: 51.5095, lon: -0.0878, altitude: 16 },
    { lat: 51.5081, lon: -0.0864, altitude: 15 },
    { lat: 51.5068, lon: -0.0850, altitude: 15 },
    { lat: 51.5054, lon: -0.0837, altitude: 14 },
    { lat: 51.5040, lon: -0.0825, altitude: 14 },
  ],
  [
    { lat: 51.5040, lon: -0.0825, altitude: 14 },
    { lat: 51.5050, lon: -0.0840, altitude: 14 },
    { lat: 51.5060, lon: -0.0855, altitude: 15 },
    { lat: 51.5068, lon: -0.0870, altitude: 15 },
    { lat: 51.5075, lon: -0.0885, altitude: 16 },
    { lat: 51.5082, lon: -0.0900, altitude: 16 },
    { lat: 51.5088, lon: -0.0915, altitude: 17 },
    { lat: 51.5092, lon: -0.0932, altitude: 17 },
    { lat: 51.5095, lon: -0.0948, altitude: 18 },
    { lat: 51.5097, lon: -0.0965, altitude: 18 },
    { lat: 51.5098, lon: -0.0982, altitude: 18 },
    { lat: 51.5097, lon: -0.1000, altitude: 18 },
    { lat: 51.5095, lon: -0.1018, altitude: 17 },
    { lat: 51.5092, lon: -0.1036, altitude: 17 },
    { lat: 51.5088, lon: -0.1055, altitude: 16 },
    { lat: 51.5083, lon: -0.1074, altitude: 16 },
    { lat: 51.5078, lon: -0.1092, altitude: 15 },
    { lat: 51.5075, lon: -0.1111, altitude: 15 },
    { lat: 51.5074, lon: -0.1130, altitude: 15 },
  ],
  [
    { lat: 51.5074, lon: -0.1130, altitude: 15 },
    { lat: 51.5065, lon: -0.1155, altitude: 15 },
    { lat: 51.5056, lon: -0.1180, altitude: 14 },
    { lat: 51.5048, lon: -0.1205, altitude: 14 },
    { lat: 51.5042, lon: -0.1230, altitude: 14 },
    { lat: 51.5045, lon: -0.1255, altitude: 14 },
    { lat: 51.5055, lon: -0.1270, altitude: 15 },
    { lat: 51.5065, lon: -0.1275, altitude: 15 },
    { lat: 51.5074, lon: -0.1278, altitude: 15 },
  ],
];

export function distanceBetweenCoords(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return (Math.round(((theta * 180) / Math.PI + 360) % 360 * 10) / 10);
}

export function getRouteTotalDistance(route: RouteWaypoint[]): number {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    total += distanceBetweenCoords(
      route[i].lat,
      route[i].lon,
      route[i + 1].lat,
      route[i + 1].lon
    );
  }
  return total;
}

export function interpolateAlongRoute(
  route: RouteWaypoint[],
  progressMeters: number
): { lat: number; lon: number; altitude: number; heading: number } {
  if (route.length === 0) {
    return { lat: 51.5074, lon: -0.1278, altitude: 15, heading: 0 };
  }
  if (route.length === 1) {
    return {
      lat: route[0].lat,
      lon: route[0].lon,
      altitude: route[0].altitude || 15,
      heading: 0,
    };
  }

  let accumulated = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const p1 = route[i];
    const p2 = route[i + 1];
    const segmentDist = distanceBetweenCoords(p1.lat, p1.lon, p2.lat, p2.lon);

    if (accumulated + segmentDist >= progressMeters || i === route.length - 2) {
      const remaining = Math.max(0, progressMeters - accumulated);
      const ratio = segmentDist > 0 ? Math.min(1, remaining / segmentDist) : 0;
      const lat = p1.lat + (p2.lat - p1.lat) * ratio;
      const lon = p1.lon + (p2.lon - p1.lon) * ratio;
      const alt1 = p1.altitude || 15;
      const alt2 = p2.altitude || 15;
      const altitude = alt1 + (alt2 - alt1) * ratio;
      const heading = calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon);
      return { lat, lon, altitude, heading };
    }
    accumulated += segmentDist;
  }

  const last = route[route.length - 1];
  const secondLast = route[route.length - 2];
  return {
    lat: last.lat,
    lon: last.lon,
    altitude: last.altitude || 15,
    heading: calculateBearing(
      secondLast.lat,
      secondLast.lon,
      last.lat,
      last.lon
    ),
  };
}
