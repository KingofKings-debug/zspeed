import { v4 as uuid } from "uuid";
import { connectionRepository } from "../repositories/connection.repository.js";
import { vehicleRepository } from "../repositories/vehicle.repository.js";
import { oemRepository, mappingRepository } from "../repositories/oem.repository.js";
import { getConnector } from "../connectors/index.js";
import type { OemConnection, OemDiscoveredVehicle } from "../types.js";

export function createConnection(
  fleetId: string,
  oemId: string,
  label: string
): OemConnection {
  const oem = oemRepository.findById(oemId);
  if (!oem) {
    throw new Error("Unsupported OEM");
  }

  return connectionRepository.create({
    id: uuid(),
    fleet_id: fleetId,
    oem_id: oemId,
    label: label || `${oem.name} Connection`,
    status: "NOT_CONFIGURED",
    account_identifier: null,
    vehicle_count: 0,
    error_message: null,
  });
}

export async function authorizeConnection(
  connectionId: string,
  fleetId: string,
  credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  const conn = connectionRepository.findById(connectionId, fleetId);
  if (!conn) {
    throw new Error("Connection not found");
  }

  const connector = getConnector(conn.oem_id);
  if (!connector) {
    throw new Error("No connector available for this OEM");
  }

  connectionRepository.updateStatus(connectionId, "AUTHORISING");

  const result = await connector.authorize(credentials);

  if (result.success) {
    connectionRepository.updateAuthorized(connectionId, result.accountId);
    return { success: true };
  } else {
    connectionRepository.updateStatus(connectionId, "NOT_CONFIGURED", result.error);
    return { success: false, error: result.error };
  }
}

export async function discoverVehicles(
  connectionId: string,
  fleetId: string
): Promise<OemDiscoveredVehicle[]> {
  const conn = connectionRepository.findById(connectionId, fleetId);
  if (!conn) {
    throw new Error("Connection not found");
  }

  if (!conn.account_identifier) {
    throw new Error("Connection not yet authorized");
  }

  const connector = getConnector(conn.oem_id);
  if (!connector) {
    throw new Error("No connector available for this OEM");
  }

  return connector.discoverVehicles(conn.account_identifier);
}

export async function activateConnection(
  connectionId: string,
  fleetId: string,
  selectedVehicles: { oem_vehicle_id: string; vin: string; categories: string[] }[]
): Promise<{ activated: number; unmapped: number }> {
  const conn = connectionRepository.findById(connectionId, fleetId);
  if (!conn) {
    throw new Error("Connection not found");
  }

  const connector = getConnector(conn.oem_id);
  if (!connector) {
    throw new Error("No connector available for this OEM");
  }

  const vehicleIds = selectedVehicles.map((v) => v.oem_vehicle_id);
  const accessResults = await connector.verifyAccess(conn.account_identifier!, vehicleIds);
  const accessMap = new Map(accessResults.map((r) => [r.vehicleId, r.accessible]));

  let activated = 0;
  let unmapped = 0;

  mappingRepository.deleteByConnection(connectionId);

  for (const sv of selectedVehicles) {
    const isAccessible = accessMap.get(sv.oem_vehicle_id) ?? false;

    const existingVehicle = vehicleRepository.findByVin(sv.vin, fleetId);

    if (existingVehicle && isAccessible) {
      mappingRepository.create({
        id: uuid(),
        vehicle_id: existingVehicle.id,
        connection_id: connectionId,
        oem_vehicle_id: sv.oem_vehicle_id,
        is_verified: true,
        data_categories: sv.categories,
      });

      vehicleRepository.updateConnection(
        existingVehicle.id,
        fleetId,
        connectionId,
        "AWAITING_DATA"
      );
      activated++;
    } else if (existingVehicle && !isAccessible) {
      vehicleRepository.updateConnection(
        existingVehicle.id,
        fleetId,
        connectionId,
        "UNAUTHORISED_VEHICLE"
      );
      unmapped++;
    } else {
      unmapped++;
    }
  }

  const success = await connector.activate(connectionId);
  if (success) {
    connectionRepository.activate(connectionId, activated);

    const mappedVehicles = vehicleRepository.findByConnection(connectionId);
    for (const v of mappedVehicles) {
      if (v.data_status === "AWAITING_DATA") {
        setTimeout(() => {
          vehicleRepository.updateLastData(v.id);
          connectionRepository.updateLastDataReceived(connectionId);
        }, 3000 + Math.random() * 5000);
      }
    }
  }

  return { activated, unmapped };
}

export async function disconnectConnection(
  connectionId: string,
  fleetId: string
): Promise<void> {
  const conn = connectionRepository.findById(connectionId, fleetId);
  if (!conn) {
    throw new Error("Connection not found");
  }

  const connector = getConnector(conn.oem_id);
  if (connector) {
    await connector.disconnect(connectionId);
  }

  connectionRepository.disconnect(connectionId);

  const vehicles = vehicleRepository.findByConnection(connectionId);
  for (const v of vehicles) {
    vehicleRepository.updateConnection(v.id, fleetId, null, "NO_CONNECTION");
  }
}

export async function reconnectConnection(
  connectionId: string,
  fleetId: string
): Promise<{ success: boolean; error?: string }> {
  const conn = connectionRepository.findById(connectionId, fleetId);
  if (!conn) {
    throw new Error("Connection not found");
  }

  const connector = getConnector(conn.oem_id);
  if (!connector) {
    throw new Error("No connector available for this OEM");
  }

  connectionRepository.updateStatus(connectionId, "AUTHORISING");
  const success = await connector.reconnect(connectionId);

  if (success) {
    connectionRepository.updateStatus(connectionId, "ACTIVE");
    return { success: true };
  } else {
    connectionRepository.updateStatus(connectionId, "EXPIRED", "Reconnection failed");
    return { success: false, error: "Reconnection failed" };
  }
}

export async function checkConnectionHealth(
  connectionId: string,
  fleetId: string
): Promise<{ healthy: boolean; message: string }> {
  const conn = connectionRepository.findById(connectionId, fleetId);
  if (!conn) {
    throw new Error("Connection not found");
  }

  const connector = getConnector(conn.oem_id);
  if (!connector) {
    return { healthy: false, message: "No connector available" };
  }

  const health = await connector.checkHealth(connectionId);
  connectionRepository.updateHealthCheck(connectionId, health.healthy, health.message);
  return health;
}
