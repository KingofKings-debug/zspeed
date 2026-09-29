import { Router } from "express";
import { getFleetId } from "../middleware/fleet.js";
import {
  getVehicleCurrentDetail,
  getVehicleTrips,
  getTripWithRoute,
  getTripGeoJson,
  enqueueProjectionRebuild,
} from "../services/projection.service.js";
import { query, queryOne } from "../db/pool.js";

const router = Router();

router.get("/:vehicleId/detail", (req, res, next) => {
  try {
    const detail = getVehicleCurrentDetail(req.params.vehicleId);
    if (!detail?.vehicle) {
      return res.status(404).json({ error: "Vehicle not found" });
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.get("/:vehicleId/trips", (req, res, next) => {
  try {
    const { from, to } = req.query;
    const trips = getVehicleTrips(
      req.params.vehicleId,
      from as string,
      to as string
    );
    res.json({ trips });
  } catch (err) {
    next(err);
  }
});

router.get("/:vehicleId/trips/:tripId", (req, res, next) => {
  try {
    const data = getTripWithRoute(req.params.tripId);
    if (!data) {
      return res.status(404).json({ error: "Trip not found" });
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get("/:vehicleId/trips/:tripId/route", (req, res, next) => {
  try {
    const geoJson = getTripGeoJson(req.params.tripId);
    if (!geoJson) {
      return res.status(404).json({ error: "Route not found for trip" });
    }
    res.json(geoJson);
  } catch (err) {
    next(err);
  }
});

router.get("/:vehicleId/trips/:tripId/events", (req, res, next) => {
  try {
    const events = query<any>(
      `SELECT te.*, ne.canonical_values as source_canonical_values
       FROM trip_events te
       LEFT JOIN normalized_events ne ON te.source_normalized_event_id = ne.id
       WHERE te.trip_id = ?
       ORDER BY te.event_time ASC`,
      [req.params.tripId]
    );

    const eventType = req.query.event_type as string;
    const filtered = eventType
      ? events.filter((e) => e.event_type === eventType)
      : events;

    res.json({ events: filtered });
  } catch (err) {
    next(err);
  }
});

router.get("/:vehicleId/trips/:tripId/quality", (req, res, next) => {
  try {
    const trip = queryOne<any>(
      "SELECT * FROM trips WHERE id = ?",
      [req.params.tripId]
    );
    if (!trip) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const route = queryOne<any>(
      "SELECT has_gaps, point_count FROM trip_routes WHERE trip_id = ?",
      [req.params.tripId]
    );

    const quarantineCount = queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM quarantine_records
       WHERE vehicle_id = ? AND status = 'UNRESOLVED'
         AND first_failure_at >= ? AND first_failure_at <= ?`,
      [req.params.vehicleId, trip.started_at, trip.ended_at || new Date().toISOString()]
    );

    const qualityNotes = JSON.parse(trip.quality_notes || "[]");

    const issues: string[] = [];
    if (route?.has_gaps) issues.push("MISSING_GPS_SEGMENTS");
    if (qualityNotes.includes("MISSING_GPS_SEGMENTS")) issues.push("MISSING_GPS_SEGMENTS");
    if ((quarantineCount?.count || 0) > 0) issues.push("QUARANTINED_EVENTS");
    if (trip.projection_status === "REBUILDING") issues.push("PROJECTION_REBUILDING");
    if (trip.projection_status === "STALE") issues.push("PROJECTION_STALE");

    res.json({
      tripId: trip.id,
      projectionStatus: trip.projection_status,
      completeness: trip.completeness_pct,
      hasGaps: route?.has_gaps === 1,
      pointCount: route?.point_count || 0,
      quarantinedEvents: quarantineCount?.count || 0,
      issues: [...new Set(issues)],
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:vehicleId/rebuild", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const { from_time, to_time, reason } = req.body;
    const jobId = enqueueProjectionRebuild(
      req.params.vehicleId,
      fleetId,
      from_time ? new Date(from_time) : null,
      to_time ? new Date(to_time) : null,
      reason || "Manual rebuild"
    );
    res.json({ jobId });
  } catch (err) {
    next(err);
  }
});

router.get("/:vehicleId/daily-summary", (req, res, next) => {
  try {
    const { from, to } = req.query;
    let sql = `SELECT * FROM vehicle_daily_summary WHERE vehicle_id = ? AND projection_status = 'CURRENT'`;
    const params: unknown[] = [req.params.vehicleId];
    if (from) { sql += " AND date >= ?"; params.push(from); }
    if (to) { sql += " AND date <= ?"; params.push(to); }
    sql += " ORDER BY date DESC LIMIT 30";
    const summaries = query<any>(sql, params);
    res.json({ summaries });
  } catch (err) {
    next(err);
  }
});

export default router;
