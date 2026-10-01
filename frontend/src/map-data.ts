export function isMapCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 &&
    typeof value[0] === "number" && Number.isFinite(value[0]) && Math.abs(value[0]) <= 180 &&
    typeof value[1] === "number" && Number.isFinite(value[1]) && Math.abs(value[1]) <= 90;
}

export function routeMapData(route: any): { geoJson: any; coordinates: [number, number][] } {
  const features: any[] = [];
  const coordinates: [number, number][] = [];
  for (const feature of Array.isArray(route?.features) ? route.features : []) {
    const geometry = feature?.geometry;
    if (geometry?.type === "Point" && isMapCoordinate(geometry.coordinates)) {
      features.push(feature);
      coordinates.push(geometry.coordinates);
    } else if (geometry?.type === "LineString" || geometry?.type === "MultiLineString") {
      const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
      for (const line of Array.isArray(lines) ? lines : []) {
        let segment: [number, number][] = [];
        const finish = () => {
          if (segment.length > 1) features.push({ ...feature, geometry: { type: "LineString", coordinates: segment } });
          segment = [];
        };
        for (const coordinate of Array.isArray(line) ? line : []) {
          if (isMapCoordinate(coordinate)) {
            segment.push(coordinate);
            coordinates.push(coordinate);
          } else {
            finish(); // Keep gaps instead of drawing a line across rejected GPS data.
          }
        }
        finish();
      }
    }
  }
  return { geoJson: { type: "FeatureCollection", features }, coordinates };
}
