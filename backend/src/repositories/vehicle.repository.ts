import { query, queryOne, run, transaction } from "../db/pool.js";
import type { Vehicle, VehicleDataStatus } from "../types.js";

export const vehicleRepository = {
  findByFleet(fleetId: string, search?: string): Vehicle[] {
    let sql = `SELECT * FROM vehicles WHERE fleet_id = ?`;
    const params: unknown[] = [fleetId];

    if (search) {
      sql += ` AND (LOWER(vin) LIKE ? OR LOWER(label) LIKE ? OR LOWER(suggested_manufacturer) LIKE ?)`;
      const term = `%${search.toLowerCase()}%`;
      params.push(term, term, term);
    }

    sql += ` ORDER BY created_at DESC`;
    return query<Vehicle>(sql, params);
  },

  findById(id: string, fleetId: string): Vehicle | undefined {
    return queryOne<Vehicle>(
      "SELECT * FROM vehicles WHERE id = ? AND fleet_id = ?",
      [id, fleetId]
    );
  },

  findByVin(vin: string, fleetId: string): Vehicle | undefined {
    return queryOne<Vehicle>(
      "SELECT * FROM vehicles WHERE vin = ? AND fleet_id = ?",
      [vin, fleetId]
    );
  },

  findByVins(vins: string[], fleetId: string): Vehicle[] {
    if (vins.length === 0) return [];
    const placeholders = vins.map(() => "?").join(",");
    return query<Vehicle>(
      `SELECT * FROM vehicles WHERE vin IN (${placeholders}) AND fleet_id = ?`,
      [...vins, fleetId]
    );
  },

  create(vehicle: {
    id: string;
    fleet_id: string;
    vin: string;
    label: string | null;
    suggested_manufacturer: string | null;
    oem_id: string | null;
    connection_id: string | null;
    data_status: VehicleDataStatus;
    import_batch_id: string | null;
  }): Vehicle {
    run(
      `INSERT INTO vehicles (id, fleet_id, vin, label, suggested_manufacturer, oem_id, connection_id, data_status, import_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vehicle.id, vehicle.fleet_id, vehicle.vin, vehicle.label,
        vehicle.suggested_manufacturer, vehicle.oem_id, vehicle.connection_id,
        vehicle.data_status, vehicle.import_batch_id,
      ]
    );
    return queryOne<Vehicle>("SELECT * FROM vehicles WHERE id = ?", [vehicle.id])!;
  },

  bulkCreate(vehicles: {
    id: string;
    fleet_id: string;
    vin: string;
    label: string | null;
    suggested_manufacturer: string | null;
    oem_id: string | null;
    connection_id: string | null;
    data_status: VehicleDataStatus;
    import_batch_id: string | null;
  }[]): number {
    if (vehicles.length === 0) return 0;

    return transaction(() => {
      let created = 0;
      for (const v of vehicles) {
        const existing = queryOne<{ id: string }>(
          "SELECT id FROM vehicles WHERE vin = ? AND fleet_id = ?",
          [v.vin, v.fleet_id]
        );
        if (!existing) {
          run(
            `INSERT INTO vehicles (id, fleet_id, vin, label, suggested_manufacturer, oem_id, connection_id, data_status, import_batch_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [v.id, v.fleet_id, v.vin, v.label, v.suggested_manufacturer, v.oem_id, v.connection_id, v.data_status, v.import_batch_id]
          );
          created++;
        }
      }
      return created;
    });
  },

  updateStatus(id: string, fleetId: string, status: VehicleDataStatus): void {
    run(
      "UPDATE vehicles SET data_status = ?, updated_at = datetime('now') WHERE id = ? AND fleet_id = ?",
      [status, id, fleetId]
    );
  },

  updateConnection(id: string, fleetId: string, connectionId: string | null, status: VehicleDataStatus): void {
    run(
      "UPDATE vehicles SET connection_id = ?, data_status = ?, updated_at = datetime('now') WHERE id = ? AND fleet_id = ?",
      [connectionId, status, id, fleetId]
    );
  },

  updateLastData(id: string): void {
    run(
      "UPDATE vehicles SET last_data_at = datetime('now'), data_status = 'RECEIVING', updated_at = datetime('now') WHERE id = ?",
      [id]
    );
  },

  countByFleet(fleetId: string): {
    total: number;
    receiving: number;
    no_connection: number;
    attention: number;
  } {
    const result = queryOne<{
      total: number;
      receiving: number;
      no_connection: number;
      attention: number;
    }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN data_status = 'RECEIVING' THEN 1 ELSE 0 END) as receiving,
        SUM(CASE WHEN data_status = 'NO_CONNECTION' THEN 1 ELSE 0 END) as no_connection,
        SUM(CASE WHEN data_status IN ('AWAITING_DATA', 'UNAUTHORISED_VEHICLE', 'STALE') THEN 1 ELSE 0 END) as attention
       FROM vehicles WHERE fleet_id = ?`,
      [fleetId]
    );
    return result || { total: 0, receiving: 0, no_connection: 0, attention: 0 };
  },

  findByConnection(connectionId: string): Vehicle[] {
    return query<Vehicle>(
      "SELECT * FROM vehicles WHERE connection_id = ?",
      [connectionId]
    );
  },

  findByOem(oemId: string, fleetId: string): Vehicle[] {
    return query<Vehicle>(
      "SELECT * FROM vehicles WHERE oem_id = ? AND fleet_id = ?",
      [oemId, fleetId]
    );
  },
};
