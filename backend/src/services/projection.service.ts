import { v4 as uuid } from "uuid";
import { query, queryOne, run, transaction } from "../db/pool.js";
import {
  segmentIntoTrips,
  calculateTripDistance,
  detectTripEvents,
  hasDataGaps,
  type GpsPoint,
} from "./trip-builder.service.js";
import {
  buildRoutePoints,
  simplifyRoute,
  detectRouteGaps,
  buildGeoJsonRoute,
  buildBoundingBox,
  type RoutePoint,
} from "./route-builder.service.js";
import { recordAndPublishFleetEvent } from "./fleet-event.service.js";

const PROCESSING_VERSION = "2";

export function buildProjectionsForVehicle(
  vehicleId: string,
  fromTime?: Date,
  toTime?: Date
): { tripsBuilt: number; errors: string[] } {
  return transaction(() => {
    const errors: string[] = [];
    let tripsBuilt = 0;

    try {
      let expandedFrom = fromTime;
      let expandedTo = toTime;

      if (fromTime) {
        const boundaryTrip = queryOne<{ started_at: string; ended_at: string }>(
          `SELECT started_at, ended_at FROM trips
           WHERE vehicle_id = ? AND ended_at >= ? AND started_at <= ?
           ORDER BY started_at ASC LIMIT 1`,
          [vehicleId, fromTime.toISOString(), fromTime.toISOString()]
        );
        if (boundaryTrip && boundaryTrip.started_at) {
          const tripStart = new Date(boundaryTrip.started_at);
          if (!expandedFrom || tripStart < expandedFrom) {
            expandedFrom = tripStart;
          }
        }
      }

      const validPoints = loadNormalizedGpsPoints(vehicleId, expandedFrom, expandedTo);
      if (validPoints.length === 0) {
        return { tripsBuilt: 0, errors: [] };
      }

      const segments = segmentIntoTrips(validPoints);

      const fleetRow = queryOne<{ fleet_id: string }>(
        "SELECT fleet_id FROM vehicles WHERE id = ?",
        [vehicleId]
      );
      if (!fleetRow) return { tripsBuilt: 0, errors: ["Vehicle not found"] };
      const fleetId = fleetRow.fleet_id;

      const usedTripIds = new Set<string>();

      for (const segment of segments) {
        try {
          const tripId = upsertTrip(vehicleId, fleetId, segment);
          usedTripIds.add(tripId);
          tripsBuilt++;
        } catch (e: any) {
          errors.push(`Trip segment ${segment.startTime.toISOString()}: ${e.message}`);
        }
      }

      supersedeObsoleteTrips(vehicleId, usedTripIds, expandedFrom, expandedTo);
      buildDailySummaries(vehicleId, fleetId, expandedFrom, expandedTo);
      updateCurrentStateSignalTimestamps(vehicleId);

    } catch (e: any) {
      errors.push(e.message);
    }

    return { tripsBuilt, errors };
  });
}

function loadNormalizedGpsPoints(
  vehicleId: string,
  fromTime?: Date,
  toTime?: Date
): GpsPoint[] {
  let sql = `
    SELECT ne.id, ne.event_time, ne.latitude, ne.longitude, ne.altitude,
           ne.canonical_values, ne.quality_flags
    FROM normalized_events ne
    WHERE ne.vehicle_id = ?
      AND ne.latitude IS NOT NULL
      AND ne.longitude IS NOT NULL
      AND ne.event_time IS NOT NULL
  `;
  const params: unknown[] = [vehicleId];

  if (fromTime) {
    sql += " AND ne.event_time >= ?";
    params.push(fromTime.toISOString());
  }
  if (toTime) {
    sql += " AND ne.event_time <= ?";
    params.push(toTime.toISOString());
  }
  sql += " ORDER BY ne.event_time ASC";

  const rows = query<any>(sql, params);
  return rows.map((r) => {
    const cv = safeJson(r.canonical_values, {});
    const qf = safeJson(r.quality_flags, []);
    return {
      eventId: r.id,
      eventTime: new Date(r.event_time),
      lat: r.latitude,
      lon: r.longitude,
      altitude: r.altitude,
      speedKmh: cv.vehicle_speed,
      ignition: cv.ignition_status,
      harshBrake: cv.harsh_brake === "YES",
      charging: cv.charging_state,
      faultCode: cv.fault_code,
      idleState: cv.idle_state,
      qualityFlags: qf,
    } as GpsPoint;
  });
}

function getNextTripNumber(vehicleId: string): number {
  const max = queryOne<{ max_num: number | null }>(
    "SELECT MAX(trip_number) as max_num FROM trips WHERE vehicle_id = ?",
    [vehicleId]
  );
  return (max?.max_num ?? 0) + 1;
}

function upsertTrip(
  vehicleId: string,
  fleetId: string,
  segment: any
): string {
  const { startTime, endTime, points } = segment;
  const distanceKm = calculateTripDistance(points);
  const durationSeconds = Math.round(
    (endTime.getTime() - startTime.getTime()) / 1000
  );
  const gaps = hasDataGaps(points);
  const qualityNotes: string[] = [];
  if (gaps) qualityNotes.push("MISSING_GPS_SEGMENTS");

  let implausibleCount = 0;
  for (const p of points) {
    if (p.qualityFlags.includes("IMPLAUSIBLE_GPS_JUMP")) implausibleCount++;
  }
  const completeness = Math.max(
    0,
    Math.round(((points.length - implausibleCount) / points.length) * 100)
  );

  const existingTrip = queryOne<{ id: string; trip_number: number }>(
    `SELECT id, trip_number FROM trips
     WHERE vehicle_id = ?
       AND (
         ABS(strftime('%s', started_at) - strftime('%s', ?)) <= 300
         OR (? >= started_at AND ? <= ended_at)
         OR (? <= started_at AND ? >= ended_at)
       )
     ORDER BY ABS(strftime('%s', started_at) - strftime('%s', ?)) ASC
     LIMIT 1`,
    [
      vehicleId,
      startTime.toISOString(),
      startTime.toISOString(),
      startTime.toISOString(),
      startTime.toISOString(),
      endTime.toISOString(),
      startTime.toISOString(),
    ]
  );

  let tripId: string;
  let tripNumber: number;

  if (existingTrip) {
    tripId = existingTrip.id;
    tripNumber = existingTrip.trip_number;
    run(
      `UPDATE trips SET
         started_at = ?, ended_at = ?, duration_seconds = ?, distance_km = ?,
         completeness_pct = ?, processing_version = ?,
         projection_status = 'CURRENT', quality_notes = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        startTime.toISOString(),
        endTime.toISOString(),
        durationSeconds,
        distanceKm,
        completeness,
        PROCESSING_VERSION,
        JSON.stringify(qualityNotes),
        tripId,
      ]
    );
  } else {
    tripId = uuid();
    tripNumber = getNextTripNumber(vehicleId);
    run(
      `INSERT INTO trips
         (id, vehicle_id, fleet_id, trip_number, started_at, ended_at,
          duration_seconds, distance_km, completeness_pct, processing_version,
          projection_status, quality_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CURRENT', ?)`,
      [
        tripId,
        vehicleId,
        fleetId,
        tripNumber,
        startTime.toISOString(),
        endTime.toISOString(),
        durationSeconds,
        distanceKm,
        completeness,
        PROCESSING_VERSION,
        JSON.stringify(qualityNotes),
      ]
    );
  }

  buildTripRoute(tripId, points);
  buildTripEvents(tripId, vehicleId, points);

  recordAndPublishFleetEvent({
    fleetId,
    eventType: "vehicle:trip",
    eventId: tripId,
    vehicleId,
    sourceEventTime: endTime.toISOString(),
    serverReceivedTime: new Date().toISOString(),
    payload: {
      tripId,
      tripState: "COMPLETED",
      startedAt: startTime.toISOString(),
      endedAt: endTime.toISOString(),
      durationSeconds,
      distanceKm,
      completeness,
      tripNumber,
    },
  });

  return tripId;
}

function supersedeObsoleteTrips(
  vehicleId: string,
  usedTripIds: Set<string>,
  fromTime?: Date,
  toTime?: Date
): void {
  const idsArray = Array.from(usedTripIds);
  let sql = `SELECT id FROM trips WHERE vehicle_id = ?`;
  const params: unknown[] = [vehicleId];

  if (fromTime) {
    sql += " AND started_at >= ?";
    params.push(fromTime.toISOString());
  }
  if (toTime) {
    sql += " AND started_at <= ?";
    params.push(toTime.toISOString());
  }

  const existingTrips = query<{ id: string }>(sql, params);
  const obsoleteIds = existingTrips
    .map((t) => t.id)
    .filter((id) => !usedTripIds.has(id));

  for (const id of obsoleteIds) {
    run("UPDATE trips SET projection_status = 'SUPERSEDED', updated_at = datetime('now') WHERE id = ?", [id]);
    run("DELETE FROM trip_events WHERE trip_id = ?", [id]);
    run("DELETE FROM trip_routes WHERE trip_id = ?", [id]);
  }
}

function buildTripRoute(tripId: string, points: GpsPoint[]): void {
  const eventMarkersOnRoute = new Set<string>();
  for (const p of points) {
    if (p.harshBrake || p.faultCode) eventMarkersOnRoute.add(p.eventId);
  }

  const routePoints = buildRoutePoints(points, eventMarkersOnRoute);
  const simplified = simplifyRoute(routePoints);
  const gaps = detectRouteGaps(points, routePoints);
  const bbox = buildBoundingBox(routePoints);
  const hasGaps = gaps.length > 0;

  const existingRoute = queryOne<{ id: string }>(
    "SELECT id FROM trip_routes WHERE trip_id = ?",
    [tripId]
  );

  if (existingRoute) {
    run(
      `UPDATE trip_routes SET
         ordered_points = ?, simplified_points = ?, bounding_box = ?,
         point_count = ?, has_gaps = ?, updated_at = datetime('now')
       WHERE trip_id = ?`,
      [
        JSON.stringify(routePoints),
        JSON.stringify(simplified),
        JSON.stringify(bbox),
        routePoints.length,
        hasGaps ? 1 : 0,
        tripId,
      ]
    );
  } else {
    run(
      `INSERT INTO trip_routes (id, trip_id, ordered_points, simplified_points, bounding_box, point_count, has_gaps)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        tripId,
        JSON.stringify(routePoints),
        JSON.stringify(simplified),
        JSON.stringify(bbox),
        routePoints.length,
        hasGaps ? 1 : 0,
      ]
    );
  }
}

function buildTripEvents(tripId: string, vehicleId: string, points: GpsPoint[]): void {
  run("DELETE FROM trip_events WHERE trip_id = ?", [tripId]);

  const events = detectTripEvents(points, tripId);
  for (const evt of events) {
    run(
      `INSERT INTO trip_events
         (id, trip_id, vehicle_id, event_type, event_time, latitude, longitude,
          severity, source_normalized_event_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        tripId,
        vehicleId,
        evt.event_type,
        evt.event_time,
        evt.latitude,
        evt.longitude,
        evt.severity,
        evt.source_normalized_event_id,
        JSON.stringify(evt.metadata),
      ]
    );
  }
}

function buildDailySummaries(
  vehicleId: string,
  fleetId: string,
  fromTime?: Date,
  toTime?: Date
): void {
  let tripSql = `
    SELECT t.id, t.started_at, t.distance_km, t.duration_seconds
    FROM trips t
    WHERE t.vehicle_id = ? AND t.projection_status = 'CURRENT'
  `;
  const params: unknown[] = [vehicleId];
  if (fromTime) {
    tripSql += " AND t.started_at >= ?";
    params.push(fromTime.toISOString());
  }
  if (toTime) {
    tripSql += " AND t.started_at <= ?";
    params.push(toTime.toISOString());
  }

  const trips = query<any>(tripSql, params);
  const byDate = new Map<string, { distance: number; tripCount: number; idle: number }>();

  for (const trip of trips) {
    const date = trip.started_at.slice(0, 10);
    if (!byDate.has(date)) {
      byDate.set(date, { distance: 0, tripCount: 0, idle: 0 });
    }
    const day = byDate.get(date)!;
    day.distance += trip.distance_km || 0;
    day.tripCount++;
  }

  for (const [date, data] of byDate) {
    const eventCounts = queryOne<any>(
      `SELECT
         SUM(CASE WHEN event_type = 'HARSH_BRAKE' THEN 1 ELSE 0 END) as harsh_brake,
         SUM(CASE WHEN event_type = 'FAULT' THEN 1 ELSE 0 END) as fault,
         SUM(CASE WHEN event_type = 'CHARGING' THEN 1 ELSE 0 END) as charging
       FROM trip_events te
       JOIN trips t ON te.trip_id = t.id
       WHERE t.vehicle_id = ? AND t.projection_status = 'CURRENT' AND substr(te.event_time, 1, 10) = ?`,
      [vehicleId, date]
    );

    run(
      `INSERT INTO vehicle_daily_summary
         (id, vehicle_id, fleet_id, date, total_distance_km, trip_count,
          idle_duration_seconds, event_counts, projection_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CURRENT')
       ON CONFLICT(vehicle_id, date) DO UPDATE SET
         total_distance_km = excluded.total_distance_km,
         trip_count = excluded.trip_count,
         idle_duration_seconds = excluded.idle_duration_seconds,
         event_counts = excluded.event_counts,
         projection_status = 'CURRENT',
         updated_at = datetime('now')`,
      [
        uuid(),
        vehicleId,
        fleetId,
        date,
        data.distance,
        data.tripCount,
        data.idle,
        JSON.stringify(eventCounts || {}),
      ]
    );
  }
}

function updateCurrentStateSignalTimestamps(vehicleId: string): void {
  const currentStateRow = queryOne<any>(
    "SELECT signal_timestamps, latest_values FROM vehicle_current_state WHERE vehicle_id = ?",
    [vehicleId]
  );
  if (!currentStateRow) return;

  const currentTimestamps: Record<string, string> = safeJson(
    currentStateRow.signal_timestamps,
    {}
  );
  const currentValues: Record<string, any> = safeJson(
    currentStateRow.latest_values,
    {}
  );

  const recentEvents = query<any>(
    `SELECT canonical_values, event_time, normalized_at
     FROM normalized_events
     WHERE vehicle_id = ? AND event_time IS NOT NULL
     ORDER BY event_time DESC
     LIMIT 100`,
    [vehicleId]
  );

  let updated = false;
  for (const row of recentEvents) {
    const cv = safeJson(row.canonical_values, {});
    const t = row.event_time || row.normalized_at;
    if (!t) continue;
    const tMillis = new Date(t).getTime();

    for (const [key, val] of Object.entries(cv)) {
      if (val === null || val === undefined) continue;
      const existingT = currentTimestamps[key];
      if (!existingT || new Date(existingT).getTime() < tMillis) {
        currentTimestamps[key] = t;
        currentValues[key] = val;
        updated = true;
      }
    }
  }

  if (updated) {
    run(
      `UPDATE vehicle_current_state
       SET signal_timestamps = ?, latest_values = ?, updated_at = datetime('now')
       WHERE vehicle_id = ?`,
      [JSON.stringify(currentTimestamps), JSON.stringify(currentValues), vehicleId]
    );
  }
}

export function enqueueProjectionRebuild(
  vehicleId: string,
  fleetId: string,
  fromTime: Date | null,
  toTime: Date | null,
  reason: string
): string {
  const jobId = uuid();
  transaction(() => {
  run(
    `INSERT INTO projection_rebuild_jobs
       (id, vehicle_id, fleet_id, from_time, to_time, reason, status)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    [
      jobId,
      vehicleId,
      fleetId,
      fromTime?.toISOString() || null,
      toTime?.toISOString() || null,
      reason,
    ]
  );
  run(`INSERT INTO job_queue(id,job_type,payload,status,priority,attempts,max_attempts)
    VALUES(?,'REBUILD_PROJECTIONS_JOB',?,'PENDING',10,0,3)`,[uuid(),JSON.stringify({jobId,vehicleId,fleetId})]);
  });
  return jobId;
}

export function runProjectionRebuildJob(jobId: string): void {
  const job = queryOne<any>(
    "SELECT * FROM projection_rebuild_jobs WHERE id = ?",
    [jobId]
  );
  if (!job) return;

  run(
    "UPDATE projection_rebuild_jobs SET status = 'RUNNING', progress_pct = 0 WHERE id = ?",
    [jobId]
  );

  try {
    const result = buildProjectionsForVehicle(
      job.vehicle_id,
      job.from_time ? new Date(job.from_time) : undefined,
      job.to_time ? new Date(job.to_time) : undefined
    );

    if (result.errors.length > 0) {
      run(
        `UPDATE projection_rebuild_jobs
         SET status = 'FAILED', progress_pct = 100, error_message = ?, completed_at = datetime('now')
         WHERE id = ?`,
        [result.errors.join("; "), jobId]
      );
    } else {
      run(
        `UPDATE projection_rebuild_jobs
         SET status = 'COMPLETED', progress_pct = 100, completed_at = datetime('now')
         WHERE id = ?`,
        [jobId]
      );
    }
  } catch (e: any) {
    run(
      `UPDATE projection_rebuild_jobs
       SET status = 'FAILED', error_message = ?, completed_at = datetime('now')
       WHERE id = ?`,
      [e.message, jobId]
    );
  }
}

export function getTripWithRoute(tripId: string): any {
  const trip = queryOne<any>(
    "SELECT * FROM trips WHERE id = ?",
    [tripId]
  );
  if (!trip) return null;

  const route = queryOne<any>(
    "SELECT * FROM trip_routes WHERE trip_id = ?",
    [tripId]
  );
  const events = query<any>(
    "SELECT * FROM trip_events WHERE trip_id = ? ORDER BY event_time ASC",
    [tripId]
  );

  return { trip, route, events };
}

export function getTripGeoJson(tripId: string): any {
  const route = queryOne<any>(
    "SELECT simplified_points, ordered_points, has_gaps FROM trip_routes WHERE trip_id = ?",
    [tripId]
  );
  if (!route) return null;

  const routePoints: RoutePoint[] = safeJson(route.simplified_points, []);
  const orderedPoints: RoutePoint[] = safeJson(route.ordered_points, []);
  const allPoints: GpsPoint[] = orderedPoints.map((p: any) => ({
    eventId: p.eventId,
    eventTime: new Date(p.eventTime),
    lat: p.lat,
    lon: p.lon,
    qualityFlags: p.qualityFlags || [],
  }));

  const gaps = detectRouteGaps(allPoints, routePoints);
  return buildGeoJsonRoute(routePoints, gaps);
}

function safeJson(val: any, fallback: any): any {
  if (!val) return fallback;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

export function getVehicleTrips(
  vehicleId: string,
  fromDate?: string,
  toDate?: string,
  limit = 50
): any[] {
  let sql = `
    SELECT t.*, tr.has_gaps, tr.point_count,
           COUNT(te.id) as event_count
    FROM trips t
    LEFT JOIN trip_routes tr ON t.id = tr.trip_id
    LEFT JOIN trip_events te ON t.id = te.trip_id
    WHERE t.vehicle_id = ? AND t.projection_status IN ('CURRENT', 'REBUILDING')
  `;
  const params: unknown[] = [vehicleId];
  if (fromDate) {
    sql += " AND t.started_at >= ?";
    params.push(fromDate);
  }
  if (toDate) {
    sql += " AND t.started_at <= ?";
    params.push(toDate + "T23:59:59Z");
  }
  sql += " GROUP BY t.id ORDER BY t.started_at DESC LIMIT ?";
  params.push(limit);
  return query<any>(sql, params);
}

export function getVehicleCurrentDetail(vehicleId: string): any {
  const state = queryOne<any>(
    "SELECT * FROM vehicle_current_state WHERE vehicle_id = ?",
    [vehicleId]
  );
  const vehicle = queryOne<any>(
    `SELECT v.*, so.name as oem_name
     FROM vehicles v
     LEFT JOIN supported_oems so ON v.oem_id = so.id
     WHERE v.id = ?`,
    [vehicleId]
  );

  const latestTrip = queryOne<any>(
    `SELECT * FROM trips WHERE vehicle_id = ? AND projection_status = 'CURRENT'
     ORDER BY started_at DESC LIMIT 1`,
    [vehicleId]
  );

  const quarantineCount = queryOne<{ count: number }>(
    `SELECT COUNT(DISTINCT raw_event_id) as count FROM quarantine_records WHERE vehicle_id = ? AND status != 'RESOLVED'`,
    [vehicleId]
  );

  return {
    vehicle,
    currentState: state
      ? {
          latestValues: safeJson(state.latest_values, {}),
          signalTimestamps: safeJson(state.signal_timestamps, {}),
          updatedAt: state.updated_at,
        }
      : null,
    latestTrip,
    unresolvedQuarantineCount: quarantineCount?.count || 0,
    dataQuality: {
      validEvents: queryOne<{ count: number }>(
        "SELECT COUNT(DISTINCT raw_event_id) AS count FROM normalized_events WHERE vehicle_id = ?", [vehicleId]
      )?.count || 0,
      quarantinedEvents: queryOne<{ count: number }>(
        "SELECT COUNT(DISTINCT raw_event_id) AS count FROM quarantine_records WHERE vehicle_id = ?", [vehicleId]
      )?.count || 0,
      unresolvedEvents: quarantineCount?.count || 0,
    },
  };
}
