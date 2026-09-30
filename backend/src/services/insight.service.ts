import { query, queryOne, run, transaction } from "../db/pool.js";
import { recordFleetEventDurable, publishFleetEventSocket } from "./fleet-event.service.js";

export interface InsightVehicleDetail {
  vehicle_id: string;
  vin: string;
  label: string;
  metric_value?: any;
  status?: string;
  supporting_events?: any[];
  timestamp?: string | null;
}

export interface InsightMetricResult {
  category: string;
  count: number;
  vehicles: InsightVehicleDetail[];
  unavailable_count?: number;
}

export function recalculateFleetInsights(fleetId: string): {
  safety_attention: number;
  service_needed: number;
  charging_needed: number;
  data_quality_issues: number;
} {
  const safetyRows = query<any>(`
    SELECT v.id as vehicle_id, v.vin, v.label,
           json_group_array(json_object(
             'event_id', te.id,
             'event_type', te.event_type,
             'event_time', te.event_time,
             'metadata', te.metadata
           )) as events_json
    FROM trip_events te
    JOIN trips t ON te.trip_id = t.id
    JOIN vehicles v ON te.vehicle_id = v.id
    WHERE v.fleet_id = ?
      AND t.projection_status = 'CURRENT'
      AND te.event_type IN ('HARSH_BRAKE', 'SPEED_VIOLATION')
      AND te.event_time > datetime('now', '-7 days')
    GROUP BY v.id, v.vin, v.label
  `, [fleetId]);

  const safetyVehicles: InsightVehicleDetail[] = safetyRows.map((r) => {
    let events = [];
    try {
      events = JSON.parse(r.events_json);
    } catch {}
    return {
      vehicle_id: r.vehicle_id,
      vin: r.vin,
      label: r.label || r.vin,
      supporting_events: events,
      timestamp: events[events.length - 1]?.event_time || null,
    };
  });

  const faultRows = query<any>(`
    SELECT v.id as vehicle_id, v.vin, v.label,
           json_extract(s.latest_values, '$.fault') as fault_val,
           json_extract(s.latest_values, '$.fault_code') as fault_code_val,
           json_extract(s.signal_timestamps, '$.fault') as fault_ts
    FROM vehicles v
    JOIN vehicle_current_state s ON v.id = s.vehicle_id
    WHERE v.fleet_id = ?
  `, [fleetId]);

  const serviceVehicles: InsightVehicleDetail[] = [];
  for (const r of faultRows) {
    const fault = r.fault_val || r.fault_code_val;
    if (fault && fault !== "null" && fault !== "NONE" && fault !== "0" && fault !== "CLEAR" && fault !== "") {
      serviceVehicles.push({
        vehicle_id: r.vehicle_id,
        vin: r.vin,
        label: r.label || r.vin,
        metric_value: fault,
        timestamp: r.fault_ts || null,
      });
    }
  }

  const socRows = query<any>(`
    SELECT v.id as vehicle_id, v.vin, v.label, v.data_status,
           json_extract(s.latest_values, '$.battery_soc') as soc_val,
           json_extract(s.signal_timestamps, '$.battery_soc') as soc_ts
    FROM vehicles v
    JOIN vehicle_current_state s ON v.id = s.vehicle_id
    WHERE v.fleet_id = ?
  `, [fleetId]);

  const chargingVehicles: InsightVehicleDetail[] = [];
  for (const r of socRows) {
    if (r.soc_val !== null && r.soc_val !== undefined && r.soc_val !== "") {
      const socNum = parseFloat(r.soc_val);
      if (!isNaN(socNum) && socNum < 20) {
        chargingVehicles.push({
          vehicle_id: r.vehicle_id,
          vin: r.vin,
          label: r.label || r.vin,
          metric_value: `${Math.round(socNum)}%`,
          status: r.data_status,
          timestamp: r.soc_ts || null,
        });
      }
    }
  }

  const qualityRows = query<any>(`
    SELECT DISTINCT v.id as vehicle_id, v.vin, v.label, v.data_status,
           (SELECT qr.failure_detail FROM quarantine_records qr WHERE qr.vehicle_id = v.id AND qr.status = 'UNRESOLVED' LIMIT 1) as q_reason,
           (SELECT qi.title FROM quarantine_incidents qi WHERE qi.fleet_id = v.fleet_id AND qi.status = 'UNRESOLVED' LIMIT 1) as qi_reason
    FROM vehicles v
    LEFT JOIN quarantine_records qr ON v.id = qr.vehicle_id AND qr.status = 'UNRESOLVED'
    WHERE v.fleet_id = ?
      AND (
        (qr.id IS NOT NULL)
        OR
        (v.data_status IN ('STALE', 'OFFLINE', 'ERROR'))
      )
  `, [fleetId]);

  const qualityVehicles: InsightVehicleDetail[] = qualityRows.map((r) => ({
    vehicle_id: r.vehicle_id,
    vin: r.vin,
    label: r.label || r.vin,
    status: r.data_status,
    metric_value: r.q_reason || r.qi_reason || (r.data_status === "STALE" ? "Stale telemetry signal" : "Connection offline"),
  }));

  const metrics: { key: string; vehicles: InsightVehicleDetail[] }[] = [
    { key: "safety_attention", vehicles: safetyVehicles },
    { key: "service_needed", vehicles: serviceVehicles },
    { key: "charging_needed", vehicles: chargingVehicles },
    { key: "data_quality_issues", vehicles: qualityVehicles },
  ];

  transaction(() => {
    for (const m of metrics) {
      run(`
        INSERT INTO fleet_insights (fleet_id, metric_key, affected_count, affected_vehicles, details, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(fleet_id, metric_key) DO UPDATE SET
          affected_count = excluded.affected_count,
          affected_vehicles = excluded.affected_vehicles,
          details = excluded.details,
          updated_at = excluded.updated_at
      `, [
        fleetId,
        m.key,
        m.vehicles.length,
        JSON.stringify(m.vehicles.map((v) => v.vehicle_id)),
        JSON.stringify(m.vehicles),
      ]);
    }
  });

  const summary = {
    safety_attention: safetyVehicles.length,
    service_needed: serviceVehicles.length,
    charging_needed: chargingVehicles.length,
    data_quality_issues: qualityVehicles.length,
  };

  const notification = recordFleetEventDurable({
    fleetId,
    eventType: "fleet:insights",
    eventId: `evt_insights_${fleetId}_${Date.now()}`,
    payload: summary,
  });
  publishFleetEventSocket(notification);

  return summary;
}

export function getFleetInsightsSummary(fleetId: string): {
  safety_attention: number;
  service_needed: number;
  charging_needed: number;
  data_quality_issues: number;
} {
  const rows = query<any>(
    "SELECT metric_key, affected_count FROM fleet_insights WHERE fleet_id = ?",
    [fleetId]
  );
  if (rows.length === 0) {
    return recalculateFleetInsights(fleetId);
  }
  const summary: Record<string, number> = {
    safety_attention: 0,
    service_needed: 0,
    charging_needed: 0,
    data_quality_issues: 0,
  };
  for (const r of rows) {
    summary[r.metric_key] = r.affected_count || 0;
  }
  return {
    safety_attention: summary.safety_attention || 0,
    service_needed: summary.service_needed || 0,
    charging_needed: summary.charging_needed || 0,
    data_quality_issues: summary.data_quality_issues || 0,
  };
}

export function getFleetInsightDrilldown(fleetId: string, category: string): InsightMetricResult {
  const row = queryOne<any>(
    "SELECT affected_count, details FROM fleet_insights WHERE fleet_id = ? AND metric_key = ?",
    [fleetId, category]
  );
  if (!row) {
    recalculateFleetInsights(fleetId);
    const refreshed = queryOne<any>(
      "SELECT affected_count, details FROM fleet_insights WHERE fleet_id = ? AND metric_key = ?",
      [fleetId, category]
    );
    if (!refreshed) {
      return { category, count: 0, vehicles: [] };
    }
    let vehicles: InsightVehicleDetail[] = [];
    try {
      vehicles = JSON.parse(refreshed.details);
    } catch {}
    return { category, count: refreshed.affected_count, vehicles };
  }

  let vehicles: InsightVehicleDetail[] = [];
  try {
    vehicles = JSON.parse(row.details);
  } catch {}
  return { category, count: row.affected_count, vehicles };
}
