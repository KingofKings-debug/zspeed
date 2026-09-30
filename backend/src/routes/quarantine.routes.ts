import { Router } from "express";
import { getFleetId, requireRole } from "../middleware/fleet.js";
import {
  getIncidents,
  getIncidentDetail,
  getAffectedVehicles,
  getQuarantineRecords,
  acknowledgeIncident,
  markIncidentReplaying,
} from "../services/quarantine.service.js";
import { replayEvents } from "../services/ingestion.service.js";
import { query, queryOne } from "../db/pool.js";
import { AppError } from "../middleware/error.js";

const router = Router();

function verifyIncidentBelongsToFleet(incidentId: string, fleetId: string) {
  const incident = queryOne<{ fleet_id: string }>(
    "SELECT fleet_id FROM quarantine_incidents WHERE id = ?",
    [incidentId]
  );
  if (!incident) {
    throw new AppError(404, "NOT_FOUND", "Incident not found");
  }
  if (incident.fleet_id !== fleetId) {
    throw new AppError(404, "NOT_FOUND", "Incident not found");
  }
}

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
    const fleetId = getFleetId(req);
    verifyIncidentBelongsToFleet(req.params.id, fleetId);
    const incident = getIncidentDetail(req.params.id);
    res.json({ incident });
  } catch (err) {
    next(err);
  }
});

router.get("/incidents/:id/vehicles", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    verifyIncidentBelongsToFleet(req.params.id, fleetId);
    const vehicles = getAffectedVehicles(req.params.id);
    res.json({ vehicles });
  } catch (err) {
    next(err);
  }
});

router.post("/incidents/:id/acknowledge", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    verifyIncidentBelongsToFleet(req.params.id, fleetId);
    const acknowledgedBy = req.auth?.userId || "fleet_manager";
    const ok = acknowledgeIncident(req.params.id, acknowledgedBy);
    if (!ok) {
      throw new AppError(404, "NOT_FOUND", "Incident not found");
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post("/incidents/:id/retry", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    verifyIncidentBelongsToFleet(req.params.id, fleetId);

    const incident = queryOne<{ id: string; oem_id: string; connection_id: string; failure_category: string }>(
      "SELECT id, oem_id, connection_id, failure_category FROM quarantine_incidents WHERE id = ?",
      [req.params.id]
    );

    if (!incident) {
      throw new AppError(404, "NOT_FOUND", "Incident not found");
    }

    const oemFormat = queryOne<{ id: string }>(
      "SELECT id FROM oem_format_versions WHERE oem_id = ? ORDER BY created_at DESC LIMIT 1",
      [incident.oem_id]
    );

    let activeProfile: { id: string } | undefined = undefined;
    if (req.body?.mapping_profile_id) {
      activeProfile = queryOne<{ id: string }>(
        "SELECT id FROM mapping_profiles WHERE id = ? AND status = 'ACTIVE'",
        [req.body.mapping_profile_id]
      );
    } else if (oemFormat) {
      activeProfile = queryOne<{ id: string }>(
        "SELECT id FROM mapping_profiles WHERE oem_format_version_id = ? AND status = 'ACTIVE'",
        [oemFormat.id]
      );
    }

    if (!activeProfile) {
      throw new AppError(400, "BAD_REQUEST", "No active published mapping profile found for this incident");
    }

    markIncidentReplaying(incident.id);

    const selectionCriteria = {
      fleet_id: fleetId,
      incident_id: incident.id,
      connection_id: incident.connection_id,
    };

    const result = replayEvents(activeProfile.id, selectionCriteria);
    res.json({ success: true, jobId: result.jobId, message: "Replay job queued" });
  } catch (err) {
    next(err);
  }
});

router.get("/records", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const { incident_id, vehicle_id, status } = req.query;
    if (incident_id) {
      verifyIncidentBelongsToFleet(incident_id as string, fleetId);
    }
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
