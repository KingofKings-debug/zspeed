import { Router } from "express";
import { replayEvents, ingestEvent } from "../services/ingestion.service.js";
import { query, queryOne, run, transaction } from "../db/pool.js";
import { getFleetId } from "../middleware/fleet.js";
import { markIncidentMappingReady, markIncidentReplaying } from "../services/quarantine.service.js";
import { v4 as uuid } from "uuid";

const router = Router();

router.post("/events", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const { connection_id, source_vehicle_id, source_event_id, payload } = req.body;

    if (!connection_id || !source_vehicle_id || !payload) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const result = ingestEvent(fleetId, connection_id, source_vehicle_id, payload, source_event_id || null);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/quarantine", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const events = query(
      "SELECT * FROM raw_events WHERE fleet_id = ? AND processing_status = 'QUARANTINED' ORDER BY recorded_at DESC LIMIT 100",
      [fleetId]
    );
    res.json({ events });
  } catch (err) {
    next(err);
  }
});

router.get("/mappings", (req, res, next) => {
  try {
    const profiles = query(`
      SELECT mp.*, ofv.oem_id, ofv.format_version, ofv.event_type, so.name as oem_name
      FROM mapping_profiles mp
      JOIN oem_format_versions ofv ON mp.oem_format_version_id = ofv.id
      LEFT JOIN supported_oems so ON ofv.oem_id = so.id
    `);
    res.json({ profiles });
  } catch (err) {
    next(err);
  }
});

router.post("/mappings", (req, res, next) => {
  try {
    const { oem_format_version_id, mapping_version, canonical_schema_version, rules } = req.body;

    const profileId = uuid();
    transaction(() => {
      run(
        `INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status)
         VALUES (?, ?, ?, ?, 'DRAFT')`,
        [profileId, oem_format_version_id, mapping_version, canonical_schema_version]
      );
      for (const rule of (rules || [])) {
        run(
          `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type, enum_mapping, validation_rule)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuid(), profileId, rule.source_field_path, rule.destination_signal_id,
           rule.conversion_type, rule.enum_mapping ? JSON.stringify(rule.enum_mapping) : null, rule.validation_rule || null]
        );
      }
    });

    res.json({ id: profileId });
  } catch (err) {
    next(err);
  }
});

router.post("/mappings/:id/publish", (req, res, next) => {
  try {
    const { id } = req.params;
    transaction(() => {
      const profile = queryOne<{ oem_format_version_id: string }>(
        "SELECT oem_format_version_id FROM mapping_profiles WHERE id = ?",
        [id]
      );
      if (profile) {
        run(
          "UPDATE mapping_profiles SET status = 'RETIRED' WHERE oem_format_version_id = ? AND status = 'ACTIVE'",
          [profile.oem_format_version_id]
        );

        const fmtRow = queryOne<{ oem_id: string; format_version: string }>(
          "SELECT oem_id, format_version FROM oem_format_versions WHERE id = ?",
          [profile.oem_format_version_id]
        );
        if (fmtRow) {
          const incidents = query<{ id: string }>(
            `SELECT id FROM quarantine_incidents WHERE oem_id = ? AND status IN ('UNRESOLVED')`,
            [fmtRow.oem_id]
          );
          for (const inc of incidents) {
            markIncidentMappingReady(inc.id);
          }
        }
      }
      run("UPDATE mapping_profiles SET status = 'ACTIVE' WHERE id = ?", [id]);
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post("/replay", (req, res, next) => {
  try {
    const { mapping_profile_id, incident_id } = req.body;
    if (!mapping_profile_id) return res.status(400).json({ error: "missing mapping_profile_id" });

    if (incident_id) {
      markIncidentReplaying(incident_id);
    }

    const result = replayEvents(mapping_profile_id, req.body.selection_criteria);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/replay/:id", (req, res, next) => {
  try {
    const job = queryOne("SELECT * FROM replay_jobs WHERE id = ?", [req.params.id]);
    res.json(job);
  } catch (err) {
    next(err);
  }
});

router.get("/pipeline-health", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const rawCount = queryOne<{ count: number }>("SELECT COUNT(*) as count FROM raw_events WHERE fleet_id = ?", [fleetId])?.count || 0;
    const processedCount = queryOne<{ count: number }>("SELECT COUNT(*) as count FROM raw_events WHERE fleet_id = ? AND processing_status = 'PROCESSED'", [fleetId])?.count || 0;
    const quarantinedCount = queryOne<{ count: number }>("SELECT COUNT(*) as count FROM raw_events WHERE fleet_id = ? AND processing_status = 'QUARANTINED'", [fleetId])?.count || 0;
    const duplicateCount = queryOne<{ count: number }>("SELECT COUNT(*) as count FROM raw_events WHERE fleet_id = ? AND processing_status = 'DUPLICATE'", [fleetId])?.count || 0;

    const incidentCount = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM quarantine_incidents WHERE fleet_id = ? AND status = 'UNRESOLVED'",
      [fleetId]
    )?.count || 0;

    const pendingJobs = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM job_queue WHERE status = 'PENDING'",
      []
    )?.count || 0;

    res.json({
      total_events: rawCount,
      processed: processedCount,
      quarantined: quarantinedCount,
      duplicates: duplicateCount,
      unresolved_incidents: incidentCount,
      pending_jobs: pendingJobs,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/rebuild-jobs", (req, res, next) => {
  try {
    const jobs = query(
      "SELECT * FROM projection_rebuild_jobs ORDER BY created_at DESC LIMIT 50"
    );
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

export default router;
