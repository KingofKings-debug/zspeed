import type { VinDecodeResult } from "../types.js";
import { oemRepository } from "../repositories/oem.repository.js";

const VIN_PREFIXES: Record<string, { manufacturer: string; oemCode: string }> = {
  "1VX": { manufacturer: "Voltera Motors", oemCode: "VOLTERA" },
  "1VL": { manufacturer: "Voltera Motors", oemCode: "VOLTERA" },
  "2CR": { manufacturer: "Crestline Automotive", oemCode: "CRESTLINE" },
  "2CS": { manufacturer: "Crestline Automotive", oemCode: "CRESTLINE" },
  "3NA": { manufacturer: "Navarro Commercial Vehicles", oemCode: "NAVARRO" },
  "3NV": { manufacturer: "Navarro Commercial Vehicles", oemCode: "NAVARRO" },
};

export function validateVinFormat(vin: string): { valid: boolean; error?: string } {
  if (!vin || typeof vin !== "string") {
    return { valid: false, error: "VIN is required" };
  }

  const cleaned = vin.trim().toUpperCase();

  if (cleaned.length !== 17) {
    return { valid: false, error: `VIN must be exactly 17 characters (got ${cleaned.length})` };
  }

  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(cleaned)) {
    return { valid: false, error: "VIN contains invalid characters (I, O, Q are not allowed)" };
  }

  return { valid: true };
}

export function decodeVin(vin: string): VinDecodeResult {
  const cleaned = vin.trim().toUpperCase();
  const prefix3 = cleaned.substring(0, 3);

  const match = VIN_PREFIXES[prefix3];
  if (match) {
    const oem = oemRepository.findByCode(match.oemCode);
    return {
      vin: cleaned,
      manufacturer: match.manufacturer,
      oem_id: oem?.id || null,
      confidence: "HIGH",
    };
  }

  const prefix2 = cleaned.substring(0, 2);
  for (const [key, value] of Object.entries(VIN_PREFIXES)) {
    if (key.startsWith(prefix2)) {
      const oem = oemRepository.findByCode(value.oemCode);
      return {
        vin: cleaned,
        manufacturer: value.manufacturer + " (uncertain)",
        oem_id: oem?.id || null,
        confidence: "LOW",
      };
    }
  }

  return {
    vin: cleaned,
    manufacturer: null,
    oem_id: null,
    confidence: "NONE",
  };
}
