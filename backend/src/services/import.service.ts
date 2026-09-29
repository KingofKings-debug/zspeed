import { v4 as uuid } from "uuid";
import { vehicleRepository } from "../repositories/vehicle.repository.js";
import { importRepository } from "../repositories/oem.repository.js";
import { validateVinFormat, decodeVin } from "./vin-decoder.service.js";
import type { ImportBatch, ImportRow, Vehicle, VehicleDataStatus } from "../types.js";

interface CsvRow {
  vin: string;
  label?: string;
}

export function parseCsvContent(content: string): CsvRow[] {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
  const vinIdx = header.indexOf("vin");
  const labelIdx = header.indexOf("label");

  if (vinIdx === -1) return [];

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const vin = cols[vinIdx] || "";
    if (!vin) continue;
    rows.push({
      vin: vin.toUpperCase(),
      label: labelIdx >= 0 ? cols[labelIdx] || undefined : undefined,
    });
  }
  return rows;
}

export function previewImport(
  fleetId: string,
  csvContent: string
): { batch: ImportBatch; rows: ImportRow[] } {
  const parsed = parseCsvContent(csvContent);

  if (parsed.length === 0) {
    const batch = importRepository.createBatch({
      id: uuid(),
      fleet_id: fleetId,
      status: "PREVIEWED",
      total_rows: 0,
      valid_rows: 0,
      error_rows: 0,
      duplicate_rows: 0,
    });
    return { batch, rows: [] };
  }

  const allVins = parsed.map((p) => p.vin);
  const existingVehicles = vehicleRepository.findByVins(allVins, fleetId);
  const existingVinSet = new Set(existingVehicles.map((v) => v.vin));
  const seenInBatch = new Set<string>();

  const importRows: ImportRow[] = [];
  let validCount = 0;
  let errorCount = 0;
  let dupCount = 0;

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    const rowId = uuid();
    const vinValidation = validateVinFormat(row.vin);

    let isValid = vinValidation.valid;
    let isDuplicate = false;
    let isUncertain = false;
    let errorMsg: string | null = vinValidation.error || null;
    let manufacturer: string | null = null;
    let oemId: string | null = null;

    if (isValid) {
      if (existingVinSet.has(row.vin) || seenInBatch.has(row.vin)) {
        isDuplicate = true;
        dupCount++;
        errorMsg = existingVinSet.has(row.vin)
          ? "Vehicle with this VIN already exists in fleet"
          : "Duplicate VIN within this import file";
      } else {
        const decoded = decodeVin(row.vin);
        manufacturer = decoded.manufacturer;
        oemId = decoded.oem_id;
        isUncertain = decoded.confidence === "LOW" || decoded.confidence === "NONE";
        validCount++;
      }
      seenInBatch.add(row.vin);
    } else {
      errorCount++;
    }

    importRows.push({
      id: rowId,
      batch_id: "",
      row_number: i + 1,
      vin: row.vin,
      label: row.label || null,
      suggested_manufacturer: manufacturer,
      oem_id: oemId,
      is_valid: isValid && !isDuplicate,
      is_duplicate: isDuplicate,
      is_uncertain_match: isUncertain,
      error_message: errorMsg,
    });
  }

  const batchId = uuid();

  for (const row of importRows) {
    row.batch_id = batchId;
  }

  const batch = importRepository.createBatch({
    id: batchId,
    fleet_id: fleetId,
    status: "PREVIEWED",
    total_rows: parsed.length,
    valid_rows: validCount,
    error_rows: errorCount,
    duplicate_rows: dupCount,
  });

  importRepository.createRows(importRows);

  return { batch, rows: importRows };
}

export function confirmImport(
  fleetId: string,
  batchId: string
): { created: number; skipped: number } {
  const batch = importRepository.findBatch(batchId, fleetId);
  if (!batch) {
    throw new Error("Import batch not found");
  }

  if (batch.status === "CONFIRMED") {
    return { created: 0, skipped: 0 };
  }

  if (batch.status !== "PREVIEWED") {
    throw new Error(`Cannot confirm batch in status: ${batch.status}`);
  }

  const rows = importRepository.findRowsByBatch(batchId);
  const validRows = rows.filter((r) => r.is_valid && !r.is_duplicate);

  const vehicles = validRows.map((r) => ({
    id: uuid(),
    fleet_id: fleetId,
    vin: r.vin,
    label: r.label,
    suggested_manufacturer: r.suggested_manufacturer,
    oem_id: r.oem_id,
    connection_id: null,
    data_status: "NO_CONNECTION" as VehicleDataStatus,
    import_batch_id: batchId,
  }));

  const created = vehicleRepository.bulkCreate(vehicles);
  importRepository.updateBatchStatus(batchId, "CONFIRMED");

  return { created, skipped: validRows.length - created };
}

export function addSingleVehicle(
  fleetId: string,
  vin: string,
  label?: string
): Vehicle {
  const validation = validateVinFormat(vin);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const cleanVin = vin.trim().toUpperCase();
  const existing = vehicleRepository.findByVin(cleanVin, fleetId);
  if (existing) {
    throw new Error("A vehicle with this VIN already exists in your fleet");
  }

  const decoded = decodeVin(cleanVin);

  return vehicleRepository.create({
    id: uuid(),
    fleet_id: fleetId,
    vin: cleanVin,
    label: label || null,
    suggested_manufacturer: decoded.manufacturer,
    oem_id: decoded.oem_id,
    connection_id: null,
    data_status: "NO_CONNECTION",
    import_batch_id: null,
  });
}
