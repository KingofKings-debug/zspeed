import { query, queryOne, run } from "../db/pool.js";
import type { SupportedOem, ImportBatch, ImportRow, IntegrationRequest, VehicleSourceMapping } from "../types.js";

interface OemDbRow {
  id: string;
  name: string;
  code: string;
  logo_url: string | null;
  supported_categories: string;
  auth_type: string;
  is_active: number;
}

function parseOem(row: OemDbRow): SupportedOem {
  return {
    ...row,
    supported_categories: JSON.parse(row.supported_categories || "[]"),
    is_active: !!row.is_active,
  };
}

export const oemRepository = {
  findAll(): SupportedOem[] {
    const rows = query<OemDbRow>(
      "SELECT * FROM supported_oems WHERE is_active = 1 ORDER BY name"
    );
    return rows.map(parseOem);
  },

  findById(id: string): SupportedOem | undefined {
    const row = queryOne<OemDbRow>(
      "SELECT * FROM supported_oems WHERE id = ?",
      [id]
    );
    return row ? parseOem(row) : undefined;
  },

  findByCode(code: string): SupportedOem | undefined {
    const row = queryOne<OemDbRow>(
      "SELECT * FROM supported_oems WHERE LOWER(code) = LOWER(?)",
      [code]
    );
    return row ? parseOem(row) : undefined;
  },
};

interface ImportRowDb extends Omit<ImportRow, "is_valid" | "is_duplicate" | "is_uncertain_match"> {
  is_valid: number;
  is_duplicate: number;
  is_uncertain_match: number;
}

function parseImportRow(row: ImportRowDb): ImportRow {
  return {
    ...row,
    is_valid: !!row.is_valid,
    is_duplicate: !!row.is_duplicate,
    is_uncertain_match: !!row.is_uncertain_match,
  };
}

export const importRepository = {
  createBatch(batch: Omit<ImportBatch, "created_at">): ImportBatch {
    run(
      `INSERT INTO import_batches (id, fleet_id, status, total_rows, valid_rows, error_rows, duplicate_rows)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [batch.id, batch.fleet_id, batch.status, batch.total_rows, batch.valid_rows, batch.error_rows, batch.duplicate_rows]
    );
    return queryOne<ImportBatch>("SELECT * FROM import_batches WHERE id = ?", [batch.id])!;
  },

  updateBatchStatus(id: string, status: ImportBatch["status"]): void {
    run("UPDATE import_batches SET status = ? WHERE id = ?", [status, id]);
  },

  findBatch(id: string, fleetId: string): ImportBatch | undefined {
    return queryOne<ImportBatch>(
      "SELECT * FROM import_batches WHERE id = ? AND fleet_id = ?",
      [id, fleetId]
    );
  },

  createRows(rows: ImportRow[]): void {
    for (const r of rows) {
      run(
        `INSERT INTO import_rows (id, batch_id, row_number, vin, label, suggested_manufacturer, oem_id, is_valid, is_duplicate, is_uncertain_match, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.batch_id, r.row_number, r.vin, r.label, r.suggested_manufacturer, r.oem_id,
         r.is_valid ? 1 : 0, r.is_duplicate ? 1 : 0, r.is_uncertain_match ? 1 : 0, r.error_message]
      );
    }
  },

  findRowsByBatch(batchId: string): ImportRow[] {
    const rows = query<ImportRowDb>(
      "SELECT * FROM import_rows WHERE batch_id = ? ORDER BY row_number",
      [batchId]
    );
    return rows.map(parseImportRow);
  },
};

interface IntegrationRequestDb extends Omit<IntegrationRequest, "desired_categories"> {
  desired_categories: string;
}

export const integrationRequestRepository = {
  create(req: Omit<IntegrationRequest, "created_at">): IntegrationRequest {
    run(
      `INSERT INTO integration_requests (id, fleet_id, manufacturer_name, fleet_size, desired_categories, contact_notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.id, req.fleet_id, req.manufacturer_name, req.fleet_size, JSON.stringify(req.desired_categories), req.contact_notes, req.status]
    );
    const row = queryOne<IntegrationRequestDb>("SELECT * FROM integration_requests WHERE id = ?", [req.id])!;
    return { ...row, desired_categories: JSON.parse(row.desired_categories || "[]") };
  },

  findByFleet(fleetId: string): IntegrationRequest[] {
    const rows = query<IntegrationRequestDb>(
      "SELECT * FROM integration_requests WHERE fleet_id = ? ORDER BY created_at DESC",
      [fleetId]
    );
    return rows.map((r) => ({ ...r, desired_categories: JSON.parse(r.desired_categories || "[]") }));
  },
};

interface MappingDbRow extends Omit<VehicleSourceMapping, "is_verified" | "data_categories"> {
  is_verified: number;
  data_categories: string;
}

export const mappingRepository = {
  create(mapping: Omit<VehicleSourceMapping, "created_at">): VehicleSourceMapping {
    run(
      `INSERT INTO vehicle_source_mappings (id, vehicle_id, connection_id, oem_vehicle_id, is_verified, data_categories)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [mapping.id, mapping.vehicle_id, mapping.connection_id, mapping.oem_vehicle_id,
       mapping.is_verified ? 1 : 0, JSON.stringify(mapping.data_categories)]
    );
    const row = queryOne<MappingDbRow>("SELECT * FROM vehicle_source_mappings WHERE id = ?", [mapping.id])!;
    return { ...row, is_verified: !!row.is_verified, data_categories: JSON.parse(row.data_categories || "[]") };
  },

  findByConnection(connectionId: string): VehicleSourceMapping[] {
    const rows = query<MappingDbRow>(
      "SELECT * FROM vehicle_source_mappings WHERE connection_id = ?",
      [connectionId]
    );
    return rows.map((r) => ({ ...r, is_verified: !!r.is_verified, data_categories: JSON.parse(r.data_categories || "[]") }));
  },

  verify(id: string): void {
    run("UPDATE vehicle_source_mappings SET is_verified = 1 WHERE id = ?", [id]);
  },

  deleteByConnection(connectionId: string): void {
    run("DELETE FROM vehicle_source_mappings WHERE connection_id = ?", [connectionId]);
  },
};
