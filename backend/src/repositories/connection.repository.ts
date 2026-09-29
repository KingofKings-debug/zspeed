import { query, queryOne, run } from "../db/pool.js";
import type { OemConnection, ConnectionStatus } from "../types.js";

export const connectionRepository = {
  findByFleet(fleetId: string): OemConnection[] {
    return query<OemConnection>(
      "SELECT * FROM oem_connections WHERE fleet_id = ? ORDER BY created_at DESC",
      [fleetId]
    );
  },

  findById(id: string, fleetId: string): OemConnection | undefined {
    return queryOne<OemConnection>(
      "SELECT * FROM oem_connections WHERE id = ? AND fleet_id = ?",
      [id, fleetId]
    );
  },

  findByOem(oemId: string, fleetId: string): OemConnection[] {
    return query<OemConnection>(
      "SELECT * FROM oem_connections WHERE oem_id = ? AND fleet_id = ? ORDER BY created_at DESC",
      [oemId, fleetId]
    );
  },

  create(conn: {
    id: string;
    fleet_id: string;
    oem_id: string;
    label: string;
    status: ConnectionStatus;
    account_identifier: string | null;
    vehicle_count: number;
    error_message: string | null;
  }): OemConnection {
    run(
      `INSERT INTO oem_connections (id, fleet_id, oem_id, label, status, account_identifier, vehicle_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [conn.id, conn.fleet_id, conn.oem_id, conn.label, conn.status, conn.account_identifier, conn.vehicle_count]
    );
    return queryOne<OemConnection>("SELECT * FROM oem_connections WHERE id = ?", [conn.id])!;
  },

  updateStatus(id: string, status: ConnectionStatus, errorMessage?: string | null): void {
    run(
      "UPDATE oem_connections SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?",
      [status, errorMessage || null, id]
    );
  },

  updateAuthorized(id: string, accountId: string): void {
    run(
      "UPDATE oem_connections SET account_identifier = ?, authorized_at = datetime('now'), status = 'VERIFYING', updated_at = datetime('now') WHERE id = ?",
      [accountId, id]
    );
  },

  activate(id: string, vehicleCount: number): void {
    run(
      "UPDATE oem_connections SET status = 'ACTIVE', vehicle_count = ?, last_health_check = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [vehicleCount, id]
    );
  },

  updateHealthCheck(id: string, healthy: boolean, message: string): void {
    const status = healthy ? "ACTIVE" : "DEGRADED";
    const errorMsg = healthy ? null : message;
    run(
      "UPDATE oem_connections SET last_health_check = datetime('now'), status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?",
      [status, errorMsg, id]
    );
  },

  updateLastDataReceived(id: string): void {
    run(
      "UPDATE oem_connections SET last_data_received = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [id]
    );
  },

  disconnect(id: string): void {
    run(
      "UPDATE oem_connections SET status = 'DISCONNECTED', updated_at = datetime('now') WHERE id = ?",
      [id]
    );
  },
};
