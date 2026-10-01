import { describe, expect, it } from "vitest";
import { isMapCoordinate, routeMapData } from "../../../frontend/src/map-data";

describe("Vehicle trip map geometry", () => {
  it("handles both route lines and event points without treating longitude as a coordinate pair", () => {
    const route = { features: [
      { geometry: { type: "LineString", coordinates: [[-0.12, 51.5], [-0.13, 51.51]] } },
      { geometry: { type: "Point", coordinates: [-0.120364, 51.5] } },
    ] };
    expect(routeMapData(route).coordinates).toEqual([[-0.12, 51.5], [-0.13, 51.51], [-0.120364, 51.5]]);
    expect(routeMapData(route).geoJson.features).toHaveLength(2);
  });
  it("keeps valid routes and splits around invalid GPS samples", () => {
    const route = { features: [{ geometry: { type: "LineString", coordinates: [
      [0, 0], [1, 1], [999, 30], [2, 2], [3, 3],
    ] } }, { geometry: { type: "Point", coordinates: [NaN, 20] } }] };
    const result = routeMapData(route);
    expect(result.geoJson.features.map(feature => feature.geometry.coordinates)).toEqual([
      [[0, 0], [1, 1]], [[2, 2], [3, 3]],
    ]);
  });
  it("accepts the equator and prime meridian and rejects nonnumeric coordinates", () => {
    expect(isMapCoordinate([0, 0])).toBe(true);
    for (const value of [-0.12, [null, 30], [20, Infinity], [20, 91], ["20", 30]]) {
      expect(isMapCoordinate(value)).toBe(false);
    }
    expect(routeMapData(null).geoJson.features).toEqual([]);
  });
  it("collects separate MultiLineString segments without connecting their gaps", () => {
    const result = routeMapData({ features: [{ geometry: { type: "MultiLineString", coordinates: [
      [[1, 1], [2, 2]], [[3, 3], [4, 4]],
    ] } }] });
    expect(result.geoJson.features).toHaveLength(2);
    expect(result.coordinates).toHaveLength(4);
  });
});
