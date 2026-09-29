import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  segmentIntoTrips,
  calculateTripDistance,
  detectTripEvents,
  filterImplausibleJumps,
  deduplicateAndSort,
  haversineKm,
  type GpsPoint,
} from "../services/trip-builder.service.js";

function makePoint(
  overrides: Partial<GpsPoint> & { lat: number; lon: number; eventId: string; eventTime: Date }
): GpsPoint {
  return {
    qualityFlags: [],
    ...overrides,
  };
}

describe("haversineKm", () => {
  it("returns 0 for identical points", () => {
    expect(haversineKm(51.5, -0.12, 51.5, -0.12)).toBe(0);
  });

  it("returns approximate distance between known points", () => {
    const d = haversineKm(51.5074, -0.1278, 51.5258, -0.1070);
    expect(d).toBeGreaterThan(2);
    expect(d).toBeLessThan(4);
  });
});

describe("deduplicateAndSort", () => {
  it("removes exact duplicate eventIds", () => {
    const t = new Date("2026-09-01T10:00:00Z");
    const p1 = makePoint({ eventId: "e1", eventTime: t, lat: 51.5, lon: -0.12 });
    const p2 = makePoint({ eventId: "e1", eventTime: t, lat: 51.5, lon: -0.12 });
    const result = deduplicateAndSort([p1, p2]);
    expect(result).toHaveLength(1);
  });

  it("sorts by eventTime ascending", () => {
    const p1 = makePoint({ eventId: "e1", eventTime: new Date("2026-09-01T10:05:00Z"), lat: 51.5, lon: -0.12 });
    const p2 = makePoint({ eventId: "e2", eventTime: new Date("2026-09-01T10:00:00Z"), lat: 51.51, lon: -0.11 });
    const result = deduplicateAndSort([p1, p2]);
    expect(result[0].eventId).toBe("e2");
    expect(result[1].eventId).toBe("e1");
  });
});

describe("filterImplausibleJumps", () => {
  it("flags points that imply >300 km/h between consecutive points", () => {
    const p1 = makePoint({ eventId: "e1", eventTime: new Date("2026-09-01T10:00:00Z"), lat: 51.5074, lon: -0.1278 });
    const p2 = makePoint({ eventId: "e2", eventTime: new Date("2026-09-01T10:00:01Z"), lat: 52.5, lon: -0.1278 });
    const result = filterImplausibleJumps([p1, p2]);
    expect(result[1].qualityFlags).toContain("IMPLAUSIBLE_GPS_JUMP");
  });

  it("does not flag reasonable speed", () => {
    const p1 = makePoint({ eventId: "e1", eventTime: new Date("2026-09-01T10:00:00Z"), lat: 51.5074, lon: -0.1278 });
    const p2 = makePoint({ eventId: "e2", eventTime: new Date("2026-09-01T10:01:00Z"), lat: 51.5184, lon: -0.1148 });
    const result = filterImplausibleJumps([p1, p2]);
    expect(result[1].qualityFlags).not.toContain("IMPLAUSIBLE_GPS_JUMP");
  });
});

describe("segmentIntoTrips – ignition-based", () => {
  function tripPoints(): GpsPoint[] {
    const base = new Date("2026-09-01T08:00:00Z");
    return [
      makePoint({ eventId: "e1", eventTime: new Date(base.getTime()), lat: 51.5074, lon: -0.1278, ignition: "ON" }),
      makePoint({ eventId: "e2", eventTime: new Date(base.getTime() + 60000), lat: 51.5100, lon: -0.1230, ignition: "ON" }),
      makePoint({ eventId: "e3", eventTime: new Date(base.getTime() + 120000), lat: 51.5130, lon: -0.1180, ignition: "ON" }),
      makePoint({ eventId: "e4", eventTime: new Date(base.getTime() + 180000), lat: 51.5180, lon: -0.1130, ignition: "OFF" }),
    ];
  }

  it("creates one trip from ignition ON to OFF", () => {
    const segments = segmentIntoTrips(tripPoints());
    expect(segments).toHaveLength(1);
    expect(segments[0].points).toHaveLength(4);
  });

  it("creates two trips from two ON/OFF cycles", () => {
    const base = new Date("2026-09-01T08:00:00Z");
    const points: GpsPoint[] = [
      makePoint({ eventId: "e1", eventTime: new Date(base.getTime()), lat: 51.5074, lon: -0.1278, ignition: "ON" }),
      makePoint({ eventId: "e2", eventTime: new Date(base.getTime() + 60000), lat: 51.5100, lon: -0.1230, ignition: "ON" }),
      makePoint({ eventId: "e3", eventTime: new Date(base.getTime() + 120000), lat: 51.5130, lon: -0.1180, ignition: "OFF" }),
      makePoint({ eventId: "e4", eventTime: new Date(base.getTime() + 1800000), lat: 51.5130, lon: -0.1180, ignition: "ON" }),
      makePoint({ eventId: "e5", eventTime: new Date(base.getTime() + 1860000), lat: 51.5200, lon: -0.1100, ignition: "ON" }),
      makePoint({ eventId: "e6", eventTime: new Date(base.getTime() + 1920000), lat: 51.5250, lon: -0.1050, ignition: "OFF" }),
    ];
    const segments = segmentIntoTrips(points);
    expect(segments).toHaveLength(2);
  });
});

describe("segmentIntoTrips – time-gap-based", () => {
  it("splits on gaps > 5 minutes", () => {
    const base = new Date("2026-09-01T08:00:00Z");
    const points: GpsPoint[] = [
      makePoint({ eventId: "e1", eventTime: new Date(base.getTime()), lat: 51.5074, lon: -0.1278 }),
      makePoint({ eventId: "e2", eventTime: new Date(base.getTime() + 60000), lat: 51.5100, lon: -0.1230 }),
      makePoint({ eventId: "e3", eventTime: new Date(base.getTime() + 400000), lat: 51.5130, lon: -0.1180 }),
      makePoint({ eventId: "e4", eventTime: new Date(base.getTime() + 460000), lat: 51.5160, lon: -0.1150 }),
      makePoint({ eventId: "e5", eventTime: new Date(base.getTime() + 520000), lat: 51.5200, lon: -0.1100 }),
    ];
    const segments = segmentIntoTrips(points);
    expect(segments).toHaveLength(2);
  });

  it("does not split on gaps < 5 minutes", () => {
    const base = new Date("2026-09-01T08:00:00Z");
    const points: GpsPoint[] = [
      makePoint({ eventId: "e1", eventTime: new Date(base.getTime()), lat: 51.5074, lon: -0.1278 }),
      makePoint({ eventId: "e2", eventTime: new Date(base.getTime() + 60000), lat: 51.5100, lon: -0.1230 }),
      makePoint({ eventId: "e3", eventTime: new Date(base.getTime() + 120000), lat: 51.5130, lon: -0.1180 }),
      makePoint({ eventId: "e4", eventTime: new Date(base.getTime() + 240000), lat: 51.5200, lon: -0.1100 }),
    ];
    const segments = segmentIntoTrips(points);
    expect(segments).toHaveLength(1);
  });
});

describe("calculateTripDistance", () => {
  it("accumulates haversine distances skipping implausible points", () => {
    const points: GpsPoint[] = [
      makePoint({ eventId: "e1", eventTime: new Date(), lat: 51.5074, lon: -0.1278 }),
      makePoint({ eventId: "e2", eventTime: new Date(), lat: 51.5100, lon: -0.1230 }),
      makePoint({ eventId: "e3", eventTime: new Date(), lat: 60.0, lon: -0.1230, qualityFlags: ["IMPLAUSIBLE_GPS_JUMP"] }),
      makePoint({ eventId: "e4", eventTime: new Date(), lat: 51.5130, lon: -0.1180 }),
    ];
    const dist = calculateTripDistance(points);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(5);
  });
});

describe("detectTripEvents", () => {
  it("generates TRIP_START and TRIP_END", () => {
    const base = new Date("2026-09-01T08:00:00Z");
    const points: GpsPoint[] = [
      makePoint({ eventId: "e1", eventTime: base, lat: 51.5074, lon: -0.1278 }),
      makePoint({ eventId: "e2", eventTime: new Date(base.getTime() + 60000), lat: 51.51, lon: -0.12 }),
    ];
    const events = detectTripEvents(points, "trip1");
    const types = events.map((e) => e.event_type);
    expect(types).toContain("TRIP_START");
    expect(types).toContain("TRIP_END");
  });

  it("generates HARSH_BRAKE event", () => {
    const base = new Date("2026-09-01T08:00:00Z");
    const points: GpsPoint[] = [
      makePoint({ eventId: "e1", eventTime: base, lat: 51.5074, lon: -0.1278 }),
      makePoint({ eventId: "e2", eventTime: new Date(base.getTime() + 30000), lat: 51.505, lon: -0.126, harshBrake: true }),
      makePoint({ eventId: "e3", eventTime: new Date(base.getTime() + 60000), lat: 51.51, lon: -0.12 }),
    ];
    const events = detectTripEvents(points, "trip1");
    expect(events.some((e) => e.event_type === "HARSH_BRAKE")).toBe(true);
  });

  it("generates FAULT event", () => {
    const base = new Date("2026-09-01T08:00:00Z");
    const points: GpsPoint[] = [
      makePoint({ eventId: "e1", eventTime: base, lat: 51.5074, lon: -0.1278 }),
      makePoint({ eventId: "e2", eventTime: new Date(base.getTime() + 30000), lat: 51.505, lon: -0.126, faultCode: "P0300" }),
      makePoint({ eventId: "e3", eventTime: new Date(base.getTime() + 60000), lat: 51.51, lon: -0.12 }),
    ];
    const events = detectTripEvents(points, "trip1");
    expect(events.some((e) => e.event_type === "FAULT")).toBe(true);
    const fault = events.find((e) => e.event_type === "FAULT");
    expect(fault?.metadata.fault_code).toBe("P0300");
  });

  it("does not generate events from empty signal values", () => {
    const base = new Date("2026-09-01T08:00:00Z");
    const points: GpsPoint[] = [
      makePoint({ eventId: "e1", eventTime: base, lat: 51.5074, lon: -0.1278 }),
      makePoint({ eventId: "e2", eventTime: new Date(base.getTime() + 60000), lat: 51.51, lon: -0.12 }),
    ];
    const events = detectTripEvents(points, "trip1");
    expect(events.some((e) => e.event_type === "HARSH_BRAKE")).toBe(false);
    expect(events.some((e) => e.event_type === "FAULT")).toBe(false);
  });
});
