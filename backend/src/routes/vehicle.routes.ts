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
import {
  getFleetInsightsSummary,
  getFleetInsightDrilldown,
} from "../services/insight.service.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const search = req.query.search as string | undefined;
    const vehicles = vehicleRepository.findByFleet(fleetId, search);
    const cursor = (getDb().prepare("SELECT last_sequence FROM fleet_event_cursors WHERE fleet_id = ?").get(fleetId) as any);
    res.json({
      vehicles,
      snapshotVersion: cursor?.last_sequence || 0,
      timestamp: new Date().toISOString(),
    });
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
    const summary = getFleetInsightsSummary(fleetId);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get("/insights/drilldown", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const category = (req.query.category as string) || "safety_attention";
    const drilldown = getFleetInsightDrilldown(fleetId, category);
    res.json(drilldown);
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
