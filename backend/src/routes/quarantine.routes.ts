import { Router } from "express";
import { getFleetId } from "../middleware/fleet.js";
import {
  getIncidents,
  getIncidentDetail,
  getAffectedVehicles,
  getQuarantineRecords,
  acknowledgeIncident,
} from "../services/quarantine.service.js";
import { query, queryOne } from "../db/pool.js";

const router = Router();

router.get("/incidents", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const status = req.query.status as string | undefined;
    const incidents = getIncidents(fleetId, status);
    res.json({ incidents });
  } catch (err) {
    next(err);
  }
});

router.get("/incidents/:id", (req, res, next) => {
  try {
    const incident = getIncidentDetail(req.params.id);
    if (!incident) {
      return res.status(404).json({ error: "Incident not found" });
    }
    res.json({ incident });
  } catch (err) {
    next(err);
  }
});

router.get("/incidents/:id/vehicles", (req, res, next) => {
  try {
    const vehicles = getAffectedVehicles(req.params.id);
    res.json({ vehicles });
  } catch (err) {
    next(err);
  }
});

router.post("/incidents/:id/acknowledge", (req, res, next) => {
  try {
    const acknowledgedBy = (req.body.acknowledged_by as string) || "fleet_manager";
    const ok = acknowledgeIncident(req.params.id, acknowledgedBy);
    if (!ok) {
      return res.status(404).json({ error: "Incident not found" });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get("/records", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const { incident_id, vehicle_id, status } = req.query;
    const records = getQuarantineRecords({
      fleetId,
      incidentId: incident_id as string,
      vehicleId: vehicle_id as string,
      status: status as string,
      limit: 100,
    });
    res.json({ records });
  } catch (err) {
    next(err);
  }
});

router.get("/summary", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);

    const counts = queryOne<any>(
      `SELECT
         COUNT(*) as total_incidents,
         SUM(CASE WHEN status = 'UNRESOLVED' THEN 1 ELSE 0 END) as unresolved,
         SUM(CASE WHEN status = 'MAPPING_READY' THEN 1 ELSE 0 END) as mapping_ready,
         SUM(CASE WHEN status = 'REPLAYING' THEN 1 ELSE 0 END) as replaying,
         SUM(CASE WHEN status = 'RESOLVED' THEN 1 ELSE 0 END) as resolved,
         SUM(affected_vehicle_count) as total_affected_vehicles,
         SUM(unresolved_event_count) as total_unresolved_events
       FROM quarantine_incidents
       WHERE fleet_id = ?`,
      [fleetId]
    );

    res.json(counts || {});
  } catch (err) {
    next(err);
  }
});

export default router;
