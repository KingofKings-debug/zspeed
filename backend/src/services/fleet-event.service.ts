import { v4 as uuid } from "uuid";
import { query, queryOne, run, transaction } from "../db/pool.js";
import { getIo } from "../socket.js";

export interface FleetSocketMessage {
  id: string;
  sequence: number;
  fleetId: string;
  eventType: string;
  eventId: string;
  vehicleId?: string;
  sourceEventTime?: string;
  serverReceivedTime: string;
  payload: any;
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

export function recordAndPublishFleetEvent(params: {
  fleetId: string;
  eventType: string;
  eventId: string;
  vehicleId?: string;
  sourceEventTime?: string | Date | null;
  serverReceivedTime?: string | null;
  payload: any;
}): FleetSocketMessage {
  const { fleetId, eventType, eventId, vehicleId, payload } = params;
  const sourceEventTime = params.sourceEventTime instanceof Date
    ? params.sourceEventTime.toISOString()
    : params.sourceEventTime || undefined;
  const serverReceivedTime = params.serverReceivedTime || new Date().toISOString();
  const id = uuid();

  let seq = 1;
  transaction(() => {
    const cursor = queryOne<{ last_sequence: number }>(
      "SELECT last_sequence FROM fleet_event_cursors WHERE fleet_id = ?",
      [fleetId]
    );
    seq = (cursor?.last_sequence || 0) + 1;

    run(
      `INSERT INTO fleet_event_cursors (fleet_id, last_sequence) VALUES (?, ?)
       ON CONFLICT(fleet_id) DO UPDATE SET last_sequence = excluded.last_sequence`,
      [fleetId, seq]
    );

    run(
      `INSERT INTO fleet_socket_events (id, fleet_id, sequence, event_type, event_id, vehicle_id, source_event_time, server_received_time, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        fleetId,
        seq,
        eventType,
        eventId,
        vehicleId || null,
        sourceEventTime || null,
        serverReceivedTime,
        JSON.stringify(payload),
        serverReceivedTime,
      ]
    );
  });

  const message: FleetSocketMessage = {
    id,
    sequence: seq,
    fleetId,
    eventType,
    eventId,
    vehicleId: vehicleId || undefined,
    sourceEventTime: sourceEventTime || undefined,
    serverReceivedTime,
    payload,
  };

  try {
    const io = getIo();
    if (io) {
      io.to(`fleet:${fleetId}`).emit("fleet:event", message);
      io.to(`fleet:${fleetId}`).emit(eventType, message);
      if (vehicleId) {
        io.to(`vehicle:${fleetId}:${vehicleId}`).emit("fleet:event", message);
        io.to(`vehicle:${fleetId}:${vehicleId}`).emit(eventType, message);
      }
    }
  } catch {}

  return message;
}

export function getCatchupEvents(
  fleetId: string,
  sinceSequence = 0,
  limit = 500
): { events: FleetSocketMessage[]; latestSequence: number } {
  const rows = query<any>(
    `SELECT * FROM fleet_socket_events WHERE fleet_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
    [fleetId, sinceSequence, limit]
  );
  const cursor = queryOne<{ last_sequence: number }>(
    "SELECT last_sequence FROM fleet_event_cursors WHERE fleet_id = ?",
    [fleetId]
  );
  const events: FleetSocketMessage[] = rows.map((r) => ({
    id: r.id,
    sequence: r.sequence,
    fleetId: r.fleet_id,
    eventType: r.event_type,
    eventId: r.event_id,
    vehicleId: r.vehicle_id || undefined,
    sourceEventTime: r.source_event_time || undefined,
    serverReceivedTime: r.server_received_time,
    payload: safeJson(r.payload, {}),
  }));

  return {
    events,
    latestSequence: cursor?.last_sequence || 0,
  };
}
