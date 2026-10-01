import { Router } from "express";
import { getFleetId, requireRole } from "../middleware/fleet.js";
import { repairContext, saveRepair, testRepair, publishRepair, repairProfile } from "../services/mapping-repair.service.js";
import { replayEvents } from "../services/ingestion.service.js";
import { markIncidentReplaying } from "../services/quarantine.service.js";
import { queryOne, run, transaction } from "../db/pool.js";
import { AppError } from "../middleware/error.js";

const router = Router();
router.use(requireRole("fleet_manager", "platform_admin"));
router.get("/incidents/:id", (req, res, next) => {
  try { res.json(repairContext(getFleetId(req), req.params.id)); } catch (error) { next(error); }
});
router.post("/incidents/:id/draft", (req, res, next) => {
  try { res.json(saveRepair(getFleetId(req), req.params.id, req.body.configuration, req.auth!.userId, req.body.profile_id, req.body.revision)); } catch (error) { next(error); }
});
router.post("/:id/test", (req, res, next) => {
  try { res.json(testRepair(getFleetId(req), req.params.id)); } catch (error) { next(error); }
});
router.post("/:id/publish", (req, res, next) => {
  try { res.json(publishRepair(getFleetId(req), req.params.id, req.auth!.userId, req.body.revision)); } catch (error) { next(error); }
});
router.post("/:id/disable", (req, res, next) => {
  try {
    const profile = repairProfile(getFleetId(req), req.params.id);
    if (profile.status !== "ACTIVE") throw new AppError(409, "CONFLICT", "Only published repairs can be disabled");
    if (queryOne("SELECT id FROM replay_jobs WHERE mapping_profile_id = ? AND status IN ('PENDING', 'RUNNING')", [req.params.id])) throw new AppError(409, "CONFLICT", "Wait for the current recovery job before disabling this mapping");
    run("UPDATE mapping_profiles SET status = 'RETIRED' WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (error) { next(error); }
});
router.post("/:id/replay", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const profile = repairProfile(fleetId, req.params.id);
    if (profile.status !== "ACTIVE") throw new AppError(400, "VALIDATION_ERROR", "Publish this repair before recovering events");
    const existing = queryOne<any>("SELECT id FROM replay_jobs WHERE mapping_profile_id = ? AND incident_id = ? AND status IN ('PENDING', 'RUNNING')", [req.params.id, profile.incident_id]);
    if (existing) { res.json({ jobId: existing.id }); return; }
    const result = transaction(() => {
      const result = replayEvents(req.params.id, { fleet_id: fleetId, incident_id: profile.incident_id, connection_id: profile.connection_id });
      markIncidentReplaying(profile.incident_id);
      return result;
    });
    res.json(result);
  } catch (error) { next(error); }
});
export default router;
