import { Router } from "express";
import crypto from "crypto";
import { replayEvents, ingestEvent, previewMapping, runMappingTests } from "../services/ingestion.service.js";
import { query, queryOne, run, transaction } from "../db/pool.js";
import { getFleetId, requireRole } from "../middleware/fleet.js";
import { markIncidentMappingReady, markIncidentReplaying } from "../services/quarantine.service.js";
import { redactSensitive } from "../services/vault.service.js";
import { getQueueHealth } from "../services/worker.service.js";
import { AppError } from "../middleware/error.js";
import { v4 as uuid } from "uuid";

const router = Router();

router.post("/webhooks/:connectionId", (req, res, next) => {
  try {
    const { connectionId } = req.params;
    const conn = queryOne<{ fleet_id: string; oem_id: string }>(
      "SELECT fleet_id, oem_id FROM oem_connections WHERE id = ?",
      [connectionId]
    );
    if (!conn) {
      throw new AppError(404, "NOT_FOUND", "Connection not found");
    }

    const sub = queryOne<{ secret: string; subscription_id: string }>(
      "SELECT subscription_id, secret FROM connector_webhook_subscriptions WHERE connection_id = ?",
      [connectionId]
    );
    if (!sub || !sub.secret) {
      throw new AppError(401, "UNAUTHORIZED", "Active registered webhook subscription required");
    }

    const receivedSig = (req.headers["x-signature-sha256"] || req.headers["x-signature"] || req.headers["x-crestline-signature"]) as string;
    if (!receivedSig) {
      throw new AppError(401, "UNAUTHORIZED", "Missing webhook signature");
    }

    let cleanReceived = receivedSig.trim();
    if (cleanReceived.startsWith("sha256=")) {
      cleanReceived = cleanReceived.slice(7);
    }

    const rawBody: Buffer = (req as any).rawBody || Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
    const expectedSig = crypto
      .createHmac("sha256", sub.secret)
      .update(rawBody)
      .digest("hex");

    const receivedBuf = Buffer.from(cleanReceived, "utf8");
    const expectedBuf = Buffer.from(expectedSig, "utf8");
    if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid webhook signature");
    }

    const payload = req.body;
    const sourceVehicleId =
      payload.vehicle_identifier ||
      payload.source_vehicle_id ||
      payload.vehicle_id ||
      payload.id;

    if (!sourceVehicleId) {
      throw new AppError(400, "VALIDATION_ERROR", "Could not determine vehicle identifier from webhook payload");
    }

    const otherMapping = queryOne<{ connection_id: string }>(
      "SELECT connection_id FROM vehicle_source_mappings WHERE oem_vehicle_id = ? AND connection_id != ?",
      [sourceVehicleId, connectionId]
    );
    if (otherMapping) {
      throw new AppError(403, "FORBIDDEN", "Vehicle belongs to another connection");
    }

    const connMappings = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM vehicle_source_mappings WHERE connection_id = ?",
      [connectionId]
    );
    if (connMappings && connMappings.count > 0) {
      const isMapped = queryOne<{ id: string }>(
        "SELECT id FROM vehicle_source_mappings WHERE connection_id = ? AND oem_vehicle_id = ?",
        [connectionId, sourceVehicleId]
      );
      if (!isMapped) {
        throw new AppError(403, "FORBIDDEN", "Vehicle is not associated with this connection");
      }
    }

    const sourceEventId =
      payload.event_id ||
      payload.source_event_id ||
      (req.headers["x-event-id"] as string) ||
      null;

    const result = ingestEvent(conn.fleet_id, connectionId, sourceVehicleId, payload, sourceEventId, true);
    const statusCode = result.status === "ACCEPTED" ? 202 : (result.status === "DUPLICATE" ? 200 : 202);
    res.status(statusCode).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/events", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const { connection_id, source_vehicle_id, source_event_id, payload } = req.body;

    if (!connection_id || !source_vehicle_id || !payload) {
      throw new AppError(400, "VALIDATION_ERROR", "Missing required fields: connection_id, source_vehicle_id, payload");
    }

    const conn = queryOne<{ fleet_id: string }>(
      "SELECT fleet_id FROM oem_connections WHERE id = ?",
      [connection_id]
    );
    if (!conn || conn.fleet_id !== fleetId) {
      throw new AppError(404, "NOT_FOUND", "Connection not found");
    }

    const result = ingestEvent(fleetId, connection_id, source_vehicle_id, payload, source_event_id || null, true);
    const statusCode = result.status === "ACCEPTED" ? 202 : (result.status === "DUPLICATE" ? 200 : 202);
    res.status(statusCode).json(result);
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

router.get("/quarantine/samples", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const oemId = req.query.oem_id as string | undefined;

    let sql = `
      SELECT re.id, re.source_vehicle_id, re.payload, re.recorded_at, oc.oem_id
      FROM raw_events re
      JOIN oem_connections oc ON re.connection_id = oc.id
      WHERE re.fleet_id = ? AND re.processing_status = 'QUARANTINED'
    `;
    const params: unknown[] = [fleetId];

    if (oemId) {
      sql += " AND oc.oem_id = ?";
      params.push(oemId);
    }

    sql += " ORDER BY re.recorded_at DESC LIMIT 20";

    const rows = query<any>(sql, params);
    const samples = rows.map((r) => {
      let parsedPayload: any = {};
      try {
        parsedPayload = JSON.parse(r.payload);
      } catch {}
      return {
        id: r.id,
        source_vehicle_id: r.source_vehicle_id,
        oem_id: r.oem_id,
        recorded_at: r.recorded_at,
        redacted_payload: redactSensitive(parsedPayload),
      };
    });

    res.json({ samples });
  } catch (err) {
    next(err);
  }
});

router.get("/mappings", (req, res, next) => {
  try {
    getFleetId(req);
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

router.post("/mappings", requireRole("platform_admin"), (req, res, next) => {
  try {
    getFleetId(req);
    const { oem_format_version_id, mapping_version, canonical_schema_version, rules } = req.body;

    if (!oem_format_version_id || !mapping_version || !canonical_schema_version) {
      throw new AppError(400, "VALIDATION_ERROR", "Missing required fields");
    }

    const profileId = uuid();
    transaction(() => {
      run(
        `INSERT INTO mapping_profiles (id, oem_format_version_id, mapping_version, canonical_schema_version, status)
         VALUES (?, ?, ?, ?, 'DRAFT')`,
        [profileId, oem_format_version_id, mapping_version, canonical_schema_version]
      );
      for (const rule of (rules || [])) {
        if (!rule.source_field_path || !rule.destination_signal_id) continue;
        run(
          `INSERT INTO mapping_rules (id, mapping_profile_id, source_field_path, destination_signal_id, conversion_type, enum_mapping, validation_rule)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuid(), profileId, rule.source_field_path, rule.destination_signal_id,
           rule.conversion_type || "DIRECT", rule.enum_mapping ? JSON.stringify(rule.enum_mapping) : null, rule.validation_rule || null]
        );
      }
    });

    res.json({ id: profileId });
  } catch (err) {
    next(err);
  }
});

router.post("/mappings/:id/preview", requireRole("platform_admin"), (req, res, next) => {
  try {
    getFleetId(req);
    const { payload, raw_event_id } = req.body;
    let samplePayload = payload;

    if (!samplePayload && raw_event_id) {
      const raw = queryOne<{ payload: string }>("SELECT payload FROM raw_events WHERE id = ?", [raw_event_id]);
      if (raw) {
        try { samplePayload = JSON.parse(raw.payload); } catch {}
      }
    }

    if (!samplePayload) {
      throw new AppError(400, "VALIDATION_ERROR", "Payload or raw_event_id is required for preview");
    }

    const result = previewMapping(req.params.id, samplePayload);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/mappings/:id/test", requireRole("platform_admin"), (req, res, next) => {
  try {
    getFleetId(req);
    const result = runMappingTests(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/mappings/:id/publish", requireRole("platform_admin"), (req, res, next) => {
  try {
    getFleetId(req);
    const { id } = req.params;
    transaction(() => {
      const profile = queryOne<{ oem_format_version_id: string }>(
        "SELECT oem_format_version_id FROM mapping_profiles WHERE id = ?",
        [id]
      );
      if (!profile) {
        throw new AppError(404, "NOT_FOUND", "Mapping profile not found");
      }

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
      run("UPDATE mapping_profiles SET status = 'ACTIVE' WHERE id = ?", [id]);
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post("/replay", requireRole("platform_admin"), (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const { mapping_profile_id, incident_id } = req.body;
    if (!mapping_profile_id) {
      throw new AppError(400, "VALIDATION_ERROR", "Missing mapping_profile_id");
    }

    if (incident_id) {
      const incident = queryOne<{ fleet_id: string }>(
        "SELECT fleet_id FROM quarantine_incidents WHERE id = ?",
        [incident_id]
      );
      if (!incident || incident.fleet_id !== fleetId) {
        throw new AppError(404, "NOT_FOUND", "Incident not found");
      }
      markIncidentReplaying(incident_id);
    }

    const selectionCriteria = { ...(req.body.selection_criteria || {}), fleet_id: fleetId };
    const result = replayEvents(mapping_profile_id, selectionCriteria);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/replay/:id", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const job = queryOne<{ id: string; selection_criteria: string }>("SELECT * FROM replay_jobs WHERE id = ?", [req.params.id]);
    if (!job) {
      throw new AppError(404, "NOT_FOUND", "Replay job not found");
    }
    const criteria = JSON.parse(job.selection_criteria || "{}");
    if (criteria.fleet_id && criteria.fleet_id !== fleetId && req.auth?.role !== "platform_admin") {
      throw new AppError(404, "NOT_FOUND", "Replay job not found");
    }
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

router.get("/queue-health", (req, res, next) => {
  try {
    const health = getQueueHealth();
    res.json(health);
  } catch (err) {
    next(err);
  }
});

router.get("/rebuild-jobs", (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const jobs = query(
      "SELECT prj.* FROM projection_rebuild_jobs prj WHERE prj.fleet_id = ? ORDER BY prj.created_at DESC LIMIT 50",
      [fleetId]
    );
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

export default router;
