import { describe, it, expect } from "vitest";
import { simplifyRoute, buildGeoJsonRoute, buildBoundingBox, type RoutePoint } from "../services/route-builder.service.js";

function makeRoutePoint(id: string, lat: number, lon: number, isMarker = false): RoutePoint {
  return { lat, lon, eventId: id, eventTime: new Date().toISOString(), isEventMarker: isMarker };
}

describe("simplifyRoute", () => {
  it("returns original points if <= 2", () => {
    const pts = [
      makeRoutePoint("e1", 51.5, -0.12),
      makeRoutePoint("e2", 51.51, -0.11),
    ];
    expect(simplifyRoute(pts)).toHaveLength(2);
  });

  it("reduces collinear points", () => {
    const pts = [
      makeRoutePoint("e1", 51.5000, -0.1200),
      makeRoutePoint("e2", 51.5050, -0.1150),
      makeRoutePoint("e3", 51.5100, -0.1100),
      makeRoutePoint("e4", 51.5150, -0.1050),
      makeRoutePoint("e5", 51.5200, -0.1000),
    ];
    const simplified = simplifyRoute(pts, 0.00001);
    expect(simplified.length).toBeLessThan(pts.length);
  });

  it("always preserves event markers", () => {
    const pts = [
      makeRoutePoint("e1", 51.5000, -0.1200),
      makeRoutePoint("e2", 51.5050, -0.1150),
      makeRoutePoint("e3", 51.5100, -0.1100, true),
      makeRoutePoint("e4", 51.5150, -0.1050),
      makeRoutePoint("e5", 51.5200, -0.1000),
    ];
    const simplified = simplifyRoute(pts, 0.00001);
    expect(simplified.some((p) => p.eventId === "e3")).toBe(true);
  });
});

describe("buildGeoJsonRoute", () => {
  it("produces FeatureCollection with LineString features", () => {
    const pts = [
      makeRoutePoint("e1", 51.5, -0.12),
      makeRoutePoint("e2", 51.51, -0.11),
      makeRoutePoint("e3", 51.52, -0.10),
    ];
    const geoJson = buildGeoJsonRoute(pts, []);
    expect(geoJson.type).toBe("FeatureCollection");
    expect(geoJson.features.length).toBeGreaterThan(0);
    expect(geoJson.features[0].geometry.type).toBe("LineString");
  });

  it("splits into multiple segments when a gap is present", () => {
    const pts = [
      makeRoutePoint("e1", 51.5, -0.12),
      makeRoutePoint("e2", 51.51, -0.11),
      makeRoutePoint("e3", 51.52, -0.10),
      makeRoutePoint("e4", 51.53, -0.09),
    ];
    const gaps = [{ gapBefore: "e2", gapAfter: "e3" }];
    const geoJson = buildGeoJsonRoute(pts, gaps);
    expect(geoJson.features.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty FeatureCollection for empty points", () => {
    const geoJson = buildGeoJsonRoute([], []);
    expect(geoJson.features).toHaveLength(0);
  });
});

describe("buildBoundingBox", () => {
  it("returns null for empty array", () => {
    expect(buildBoundingBox([])).toBeNull();
  });

  it("returns correct bounding box", () => {
    const pts = [
      makeRoutePoint("e1", 51.5, -0.12),
      makeRoutePoint("e2", 51.52, -0.10),
      makeRoutePoint("e3", 51.49, -0.13),
    ];
    const bbox = buildBoundingBox(pts);
    expect(bbox).not.toBeNull();
    if (bbox) {
      const [minLon, minLat, maxLon, maxLat] = bbox;
      expect(minLon).toBeCloseTo(-0.13);
      expect(maxLon).toBeCloseTo(-0.10);
      expect(minLat).toBeCloseTo(51.49);
      expect(maxLat).toBeCloseTo(51.52);
    }
  });
});
