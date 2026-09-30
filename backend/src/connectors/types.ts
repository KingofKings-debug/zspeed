import type { OemDiscoveredVehicle } from "../types.js";

export interface OemConnectorContract {
  readonly oemId: string;
  readonly name: string;
  readonly isDemo: boolean;

  authorize(credentials: Record<string, string>): Promise<{
    success: boolean;
    accountId?: string;
    secretRef?: string;
    error?: string;
  }>;

  discoverVehicles(accountId: string): Promise<OemDiscoveredVehicle[]>;

  verifyAccess(
    accountId: string,
    vehicleIds: string[]
  ): Promise<{ vehicleId: string; accessible: boolean }[]>;

  activate(
    connectionId: string,
    fleetId: string,
    mappedVehicles: { oem_vehicle_id: string; vin: string }[]
  ): Promise<boolean>;

  disconnect(connectionId: string): Promise<boolean>;

  reconnect(
    connectionId: string,
    credentials?: Record<string, string>
  ): Promise<{ success: boolean; error?: string }>;

  checkHealth(connectionId: string): Promise<{
    healthy: boolean;
    message: string;
    expired?: boolean;
  }>;

  startDelivery?(
    connectionId: string,
    fleetId: string,
    onEvent: (sourceVehicleId: string, payload: any) => Promise<any> | any
  ): void;

  stopDelivery?(connectionId: string): void;
}
