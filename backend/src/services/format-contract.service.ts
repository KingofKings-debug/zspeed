import { query, queryOne } from "../db/pool.js";

export interface FieldContract {
  path: string;
  type: "number" | "string" | "boolean";
  required: boolean;
  is_time?: boolean;
  is_lat?: boolean;
  is_lon?: boolean;
  min?: number;
  max?: number;
}

export interface FormatContract {
  id: string;
  oem_id: string;
  format_version: string;
  event_type: string;
  fields: FieldContract[];
}

export interface ValidationOutcome {
  valid: boolean;
  detectedVersion?: string;
  formatVersionId?: string;
  failureCategory?:
    | "UNKNOWN_FORMAT"
    | "SCHEMA_CHANGE"
    | "INVALID_VALUE"
    | "INVALID_COORDINATES"
    | "INVALID_TIME"
    | "TYPE_ERROR";
  errorReason?: string;
  observedStructure?: string;
}

export function getNestedValue(obj: any, path: string): any {
  if (!obj || typeof obj !== "object") return undefined;
  if (obj[path] !== undefined) return obj[path];
  const parts = path.split(".");
  let curr = obj;
  for (const part of parts) {
    if (curr === null || curr === undefined || typeof curr !== "object") {
      return undefined;
    }
    curr = curr[part];
  }
  return curr;
}

function parseStructureToContract(
  id: string,
  oemId: string,
  formatVersion: string,
  eventType: string,
  structureJson: string
): FormatContract {
  let parsed: any = {};
  try {
    parsed = JSON.parse(structureJson);
  } catch {}

  if (Array.isArray(parsed.required_fields)) {
    const fields: FieldContract[] = [];
    for (const f of parsed.required_fields) {
      fields.push({
        path: f.path,
        type: f.type || "number",
        required: true,
        is_time: !!f.is_time,
        is_lat: !!f.is_lat,
        is_lon: !!f.is_lon,
        min: f.min,
        max: f.max,
      });
    }
    for (const f of parsed.optional_fields || []) {
      fields.push({
        path: f.path,
        type: f.type || "number",
        required: false,
        is_time: !!f.is_time,
        is_lat: !!f.is_lat,
        is_lon: !!f.is_lon,
        min: f.min,
        max: f.max,
      });
    }
    return {
      id,
      oem_id: oemId,
      format_version: formatVersion,
      event_type: eventType,
      fields,
    };
  }

  const fields: FieldContract[] = [];

  if (oemId === "oem_voltera" && formatVersion === "v1") {
    fields.push(
      { path: "speed_mph", type: "number", required: true, min: 0, max: 250 },
      { path: "charge_fraction", type: "number", required: true, min: 0, max: 1 },
      { path: "timestamp", type: "string", required: true, is_time: true },
      { path: "lat", type: "number", required: false, is_lat: true, min: -90, max: 90 },
      { path: "lon", type: "number", required: false, is_lon: true, min: -180, max: 180 },
      { path: "odo_miles", type: "number", required: false, min: 0 },
      { path: "status", type: "string", required: false },
      { path: "altitude", type: "number", required: false },
      { path: "heading", type: "number", required: false },
      { path: "harsh_brake", type: "boolean", required: false },
      { path: "fault_code", type: "string", required: false }
    );
  } else if (oemId === "oem_voltera" && formatVersion === "v2") {
    fields.push(
      { path: "data.speed_mph", type: "number", required: true, min: 0, max: 250 },
      { path: "data.charge_fraction", type: "number", required: true, min: 0, max: 1 },
      { path: "data.lat", type: "number", required: true, is_lat: true, min: -90, max: 90 },
      { path: "data.lon", type: "number", required: true, is_lon: true, min: -180, max: 180 },
      { path: "metadata.timestamp", type: "string", required: true, is_time: true },
      { path: "metadata.odo_miles", type: "number", required: false, min: 0 },
      { path: "metadata.status", type: "string", required: false },
      { path: "metadata.fault_code", type: "string", required: false }
    );
  } else if (oemId === "oem_crestline" && formatVersion === "v1") {
    fields.push(
      { path: "state.velocity_kmh", type: "number", required: true, min: 0, max: 350 },
      { path: "state.battery_pct", type: "number", required: true, min: 0, max: 100 },
      { path: "state.gps_lat", type: "number", required: true, is_lat: true, min: -90, max: 90 },
      { path: "state.gps_lon", type: "number", required: true, is_lon: true, min: -180, max: 180 },
      { path: "time_measured", type: "number", required: true, is_time: true },
      { path: "state.distance_km", type: "number", required: false },
      { path: "state.ignition", type: "boolean", required: false },
      { path: "state.gps_heading", type: "number", required: false },
      { path: "state.harsh_braking", type: "boolean", required: false },
      { path: "state.charging", type: "boolean", required: false },
      { path: "state.fault", type: "string", required: false }
    );
  } else {
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "string") {
        fields.push({
          path: key,
          type: (val as any) === "boolean" ? "boolean" : (val as any) === "string" ? "string" : "number",
          required: true,
          is_time: key.toLowerCase().includes("time"),
          is_lat: key.toLowerCase().includes("lat"),
          is_lon: key.toLowerCase().includes("lon"),
        });
      }
    }
  }

  return {
    id,
    oem_id: oemId,
    format_version: formatVersion,
    event_type: eventType,
    fields,
  };
}

export function loadContractsForOem(oemId: string): FormatContract[] {
  const rows = query<any>(
    `SELECT ofv.id, ofv.oem_id, ofv.format_version, ofv.event_type, ofv.expected_structure FROM oem_format_versions ofv
     WHERE ofv.oem_id = ? AND NOT EXISTS (
       SELECT 1 FROM mapping_profiles mp JOIN mapping_repairs mr ON mr.profile_id = mp.id WHERE mp.oem_format_version_id = ofv.id
     ) ORDER BY ofv.format_version DESC`,
    [oemId]
  );

  return rows.map((r) =>
    parseStructureToContract(r.id, r.oem_id, r.format_version, r.event_type, r.expected_structure)
  );
}

export function evaluatePayloadAgainstContract(
  contract: FormatContract,
  payload: any
): { matchesRequired: boolean; missingRequired?: string; errors: { category: ValidationOutcome["failureCategory"]; reason: string }[] } {
  const errors: { category: ValidationOutcome["failureCategory"]; reason: string }[] = [];

  for (const field of contract.fields) {
    let val = getNestedValue(payload, field.path);

    if (val === undefined || val === null) {
      if (contract.oem_id === "oem_crestline" && field.path.startsWith("state.")) {
        const altPath = field.path.replace("state.", "");
        val = getNestedValue(payload, altPath);
      }
    }

    if (field.required && (val === undefined || val === null)) {
      return {
        matchesRequired: false,
        missingRequired: field.path,
        errors: [],
      };
    }

    if (val !== undefined && val !== null) {
      if (field.type === "number") {
        if (typeof val !== "number" || isNaN(val)) {
          errors.push({
            category: "INVALID_VALUE",
            reason: `Invalid number value for signal ${field.path} (type error)`,
          });
          continue;
        }

        if (field.min !== undefined && val < field.min) {
          if (field.is_lat || field.is_lon) {
            errors.push({
              category: "INVALID_COORDINATES",
              reason: `Coordinate value ${val} for '${field.path}' is below minimum ${field.min}`,
            });
          } else {
            errors.push({
              category: "INVALID_VALUE",
              reason: `Value ${val} for '${field.path}' is below minimum ${field.min}`,
            });
          }
        }

        if (field.max !== undefined && val > field.max) {
          if (field.is_lat || field.is_lon) {
            errors.push({
              category: "INVALID_COORDINATES",
              reason: `Coordinate value ${val} for '${field.path}' exceeds maximum ${field.max}`,
            });
          } else {
            errors.push({
              category: "INVALID_VALUE",
              reason: `Value ${val} for '${field.path}' exceeds maximum ${field.max}`,
            });
          }
        }
      } else if (field.type === "string") {
        if (typeof val !== "string") {
          errors.push({
            category: "TYPE_ERROR",
            reason: `Invalid type for field '${field.path}': expected string, got ${typeof val}`,
          });
          continue;
        }
      } else if (field.type === "boolean") {
        if (typeof val !== "boolean") {
          errors.push({
            category: "TYPE_ERROR",
            reason: `Invalid type for field '${field.path}': expected boolean, got ${typeof val}`,
          });
          continue;
        }
      }

      if (field.is_time) {
        let validDate = false;
        if (typeof val === "string") {
          const d = new Date(val);
          validDate = !isNaN(d.getTime()) && val.length > 5;
        } else if (typeof val === "number") {
          validDate = val > 0 && !isNaN(val);
        }
        if (!validDate) {
          errors.push({
            category: "INVALID_TIME",
            reason: `Invalid event timestamp '${val}' for field '${field.path}'`,
          });
        }
      }
    }
  }

  return {
    matchesRequired: true,
    errors,
  };
}

export function detectAndValidateFormat(
  oemId: string,
  payload: any
): ValidationOutcome {
  const contracts = loadContractsForOem(oemId);
  const observedKeys = Object.keys(payload);
  const observedStructure = JSON.stringify(observedKeys).slice(0, 120);

  if (contracts.length === 0) {
    return {
      valid: false,
      failureCategory: "UNKNOWN_FORMAT",
      errorReason: `No format contracts registered for OEM '${oemId}'`,
      observedStructure,
    };
  }

  for (const contract of contracts) {
    const result = evaluatePayloadAgainstContract(contract, payload);

    if (result.matchesRequired) {
      if (result.errors.length > 0) {
        return {
          valid: false,
          detectedVersion: contract.format_version,
          formatVersionId: contract.id,
          failureCategory: result.errors[0].category,
          errorReason: result.errors[0].reason,
          observedStructure,
        };
      }

      return {
        valid: true,
        detectedVersion: contract.format_version,
        formatVersionId: contract.id,
      };
    }
  }

  return {
    valid: false,
    failureCategory: "SCHEMA_CHANGE",
    errorReason: `Payload does not match any published format contract for OEM '${oemId}'. Observed structure: ${observedStructure}`,
    observedStructure,
  };
}
