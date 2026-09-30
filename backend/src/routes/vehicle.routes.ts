import { Router } from "express";
import { vehicleRepository } from "../repositories/vehicle.repository.js";
import { getDb } from "../db/pool.js";
import { previewImport, confirmImport, addSingleVehicle } from "../services/import.service.js";
import { getFleetId } from "../middleware/fleet.js";
import { AppError } from "../middleware/error.js";
import multer from "multer";
import { getCatchupEvents } from "../services/fleet-event.service.js";
import {
  computeVehicleLiveState,
  computeMovementState,
  computeDataFreshness,
} from "../services/vehicle-state.service.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const search = req.query.search as string | undefined;
    const vehicles = vehicleRepository.findByFleet(fleetId, search);
    res.json({ vehicles });
  } catch (err) {
    next(err);
  }
});

router.get("/stats", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const stats = vehicleRepository.countByFleet(fleetId);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

router.get("/insights", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const db = getDb();
    
    const safetyRes = db.prepare(`
      SELECT COUNT(DISTINCT te.vehicle_id) as c
      FROM trip_events te
      JOIN vehicles v ON te.vehicle_id = v.id
      WHERE v.fleet_id = ? AND te.event_type IN ('HARSH_BRAKE', 'SPEED_VIOLATION') 
      AND te.event_time > datetime('now', '-7 days')
    `).get(fleetId) as any;

    const serviceRes = db.prepare(`
      SELECT COUNT(DISTINCT te.vehicle_id) as c
      FROM trip_events te
      JOIN vehicles v ON te.vehicle_id = v.id
      WHERE v.fleet_id = ? AND te.event_type = 'FAULT'
      AND te.event_time > datetime('now', '-7 days')
    `).get(fleetId) as any;

    const chargingRes = db.prepare(`
      SELECT COUNT(*) as c
      FROM vehicle_current_state
      WHERE vehicle_id IN (SELECT id FROM vehicles WHERE fleet_id = ?)
      AND json_extract(latest_values, '$.battery_soc') < 20
    `).get(fleetId) as any;

    const dataQualityRes = db.prepare(`
      SELECT SUM(affected_vehicle_count) as c
      FROM quarantine_incidents
      WHERE fleet_id = ? AND status = 'UNRESOLVED'
    `).get(fleetId) as any;

    res.json({
      safety_attention: safetyRes?.c || 0,
      service_needed: serviceRes?.c || 0,
      charging_needed: chargingRes?.c || 0,
      data_quality_issues: dataQualityRes?.c || 0
    });
  } catch (err) {
    next(err);
  }
});

router.get("/catchup", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const since = parseInt(req.query.since as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
    const result = getCatchupEvents(fleetId, since, limit);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/live-states", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const db = getDb();
    const rows = db.prepare(`
      SELECT v.id as vehicle_id, v.vin, v.label, v.data_status, v.live_state,
             v.last_data_at, v.connection_id, oc.status as connection_status,
             s.latest_values, s.signal_timestamps, s.updated_at as state_updated_at
      FROM vehicles v
      LEFT JOIN oem_connections oc ON v.connection_id = oc.id
      LEFT JOIN vehicle_current_state s ON v.id = s.vehicle_id
      WHERE v.fleet_id = ?
    `).all(fleetId) as any[];

    const states = rows.map((r) => {
      const vals = r.latest_values ? JSON.parse(r.latest_values) : {};
      const stamps = r.signal_timestamps ? JSON.parse(r.signal_timestamps) : {};
      const computedState = computeVehicleLiveState({
        hasActiveConnection: r.connection_status === "ACTIVE",
        lastReceiptTime: r.state_updated_at || r.last_data_at,
        sourceEventTime: stamps.latitude || stamps.vehicle_speed || stamps.event_time,
        speed: vals.vehicle_speed,
        ignition: vals.ignition_status,
      });

      const movementState = computeMovementState(
        vals.vehicle_speed,
        vals.ignition_status,
        vals.charging_state === "CHARGING" || vals.charging === true
      );

      const dataFreshness = computeDataFreshness({
        hasActiveConnection: r.connection_status === "ACTIVE",
        lastReceiptTime: r.state_updated_at || r.last_data_at,
      });

      return {
        vehicle_id: r.vehicle_id,
        vin: r.vin,
        label: r.label,
        data_status: r.data_status,
        live_state: computedState,
        movement_state: movementState,
        data_freshness: dataFreshness,
        speed: vals.vehicle_speed !== undefined && vals.vehicle_speed !== null ? Number(vals.vehicle_speed) : null,
        speed_unit: "km/h",
        latitude: vals.latitude !== undefined && vals.latitude !== null ? Number(vals.latitude) : null,
        longitude: vals.longitude !== undefined && vals.longitude !== null ? Number(vals.longitude) : null,
        battery_soc: vals.battery_soc !== undefined && vals.battery_soc !== null ? Number(vals.battery_soc) : null,
        odometer: vals.odometer !== undefined && vals.odometer !== null ? Number(vals.odometer) : null,
        ignition: vals.ignition_status || null,
        latest_values: vals,
        signal_timestamps: stamps,
        last_data_at: r.last_data_at,
      };
    });

    res.json({ states });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const vehicle = vehicleRepository.findById(req.params.id, fleetId);
    if (!vehicle) {
      throw new AppError(404, "NOT_FOUND", "Vehicle not found");
    }
    res.json(vehicle);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const { vin, label } = req.body;
    if (!vin) {
      throw new AppError(400, "VALIDATION_ERROR", "VIN is required");
    }
    const vehicle = addSingleVehicle(fleetId, vin, label);
    res.status(201).json(vehicle);
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "VALIDATION_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

router.post("/import/preview", upload.single("file"), async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    let csvContent: string;

    if (req.file) {
      csvContent = req.file.buffer.toString("utf-8");
    } else if (req.body.csv) {
      csvContent = req.body.csv;
    } else {
      throw new AppError(400, "VALIDATION_ERROR", "No CSV file or content provided");
    }

    const result = previewImport(fleetId, csvContent);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/import/:batchId/confirm", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const result = confirmImport(fleetId, req.params.batchId);
    res.json(result);
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "IMPORT_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

export default router;
