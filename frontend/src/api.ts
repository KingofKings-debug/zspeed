import { getToken, clearSession, getApiBase } from "./session";

const API_BASE = getApiBase();

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "unauthorized" | "forbidden" | "not_found" | "server_error" | "network" | "bad_response",
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

async function request<T>(url: string, options?: RequestInit, snapshotRetries=0): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...options?.headers,
      },
    });
  } catch {
    throw new ApiError(0, "network", "Unable to reach the backend. Check that the platform is running on port 3001.");
  }

  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, "unauthorized", "Session expired or authentication required.");
  }
  if (res.status === 403) {
    throw new ApiError(403, "forbidden", "You do not have permission to perform this action.");
  }
  if (res.status === 404) {
    const body=await res.json().catch(()=>({}));
    if(body.code==='READ_MODEL_PENDING' && snapshotRetries<10) {
      await new Promise(resolve=>setTimeout(resolve,1500));
      return request<T>(url,options,snapshotRetries+1);
    }
    if(body.code==='READ_MODEL_PENDING') throw new ApiError(404,'not_found',body.message);
    throw new ApiError(404, "not_found", "The requested resource was not found.");
  }
  if (res.status >= 500) {
    const text = await res.text().catch(() => "");
    let msg = `Backend error (${res.status})`;
    try {
      const data = JSON.parse(text);
      if (data.message) msg = data.message;
    } catch {}
    throw new ApiError(res.status, "server_error", msg);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `Request failed: ${res.status}`;
    try {
      const data = JSON.parse(text);
      if (data.message) msg = data.message;
    } catch {}
    throw new ApiError(res.status, "server_error", msg);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(res.status, "bad_response", "Unexpected non-JSON response from backend.");
  }

  return res.json();
}

export async function authedFetch(url: string, options?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    const resolvedUrl = url.startsWith("/api/") ? `${API_BASE}${url.slice(4)}` : url;
    res = await fetch(resolvedUrl, {
      ...options,
      headers: {
        ...authHeaders(),
        ...options?.headers,
      },
    });
  } catch {
    throw new ApiError(0, "network", "Unable to reach the backend.");
  }
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, "unauthorized", "Session expired or authentication required.");
  }
  if (res.status === 403) {
    throw new ApiError(403, "forbidden", "Permission denied.");
  }
  return res;
}

export const api = {
  getRepairContext: (id: string) => request<any>(`/ingestion/repair/incidents/${id}`),
  saveMappingRepair: (id: string, configuration: any, profile_id?: string, revision?: number) => request<{ id: string; revision: number }>(`/ingestion/repair/incidents/${id}/draft`, { method: "POST", body: JSON.stringify({ configuration, profile_id, revision }) }),
  testMappingRepair: (id: string) => request<any>(`/ingestion/repair/${id}/test`, { method: "POST" }),
  publishMappingRepair: (id: string, revision: number) => request<any>(`/ingestion/repair/${id}/publish`, { method: "POST", body: JSON.stringify({ revision }) }),
  replayMappingRepair: (id: string) => request<{ jobId: string }>(`/ingestion/repair/${id}/replay`, { method: "POST" }),
  disableMappingRepair: (id: string) => request<any>(`/ingestion/repair/${id}/disable`, { method: "POST" }),
  getReplayJob: (id: string) => request<any>(`/ingestion/replay/${id}`),
  getStats: () =>
    request<{ total: number; receiving: number; no_connection: number; attention: number }>("/vehicles/stats"),

  getInsights: () =>
    request<{ safety_attention: number; service_needed: number; charging_needed: number; data_quality_issues: number }>(
      "/vehicles/insights"
    ),

  getInsightDrilldown: (category: string) =>
    request<{ category: string; count: number; vehicles: any[] }>(
      `/vehicles/insights/drilldown?category=${encodeURIComponent(category)}`
    ),

  getVehicles: (search?: string) => {
    const q = search ? `?search=${encodeURIComponent(search)}` : "";
    return request<{ vehicles: any[] }>(`/vehicles${q}`);
  },

  addVehicle: (vin: string, label?: string) =>
    request<any>("/vehicles", { method: "POST", body: JSON.stringify({ vin, label }) }),

  previewImport: async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await authedFetch(`${API_BASE}/vehicles/import/preview`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || "Import preview failed");
    }
    return res.json();
  },

  confirmImport: (batchId: string) =>
    request<{ created: number; skipped: number }>(`/vehicles/import/${batchId}/confirm`, { method: "POST" }),

  getOems: () => request<{ oems: any[] }>("/oems"),

  getOem: (id: string) => request<any>(`/oems/${id}`),

  getConnections: () => request<{ connections: any[] }>("/connections"),

  getConnection: (id: string) => request<any>(`/connections/${id}`),

  createConnection: (oemId: string, label: string) =>
    request<any>("/connections", { method: "POST", body: JSON.stringify({ oem_id: oemId, label }) }),

  authorizeConnection: (id: string, credentials: Record<string, string>) =>
    request<{ success: boolean; error?: string }>(`/connections/${id}/authorize`, {
      method: "POST",
      body: JSON.stringify({ credentials }),
    }),

  discoverVehicles: (connectionId: string) =>
    request<{ vehicles: any[] }>(`/connections/${connectionId}/discover`),

  activateConnection: (
    connectionId: string,
    vehicles: { oem_vehicle_id: string; vin: string; categories: string[] }[]
  ) =>
    request<{ activated: number; unmapped: number }>(`/connections/${connectionId}/activate`, {
      method: "POST",
      body: JSON.stringify({ vehicles }),
    }),

  disconnectConnection: (id: string) =>
    request<{ success: boolean }>(`/connections/${id}/disconnect`, { method: "POST" }),

  reconnectConnection: (id: string) =>
    request<{ success: boolean; error?: string }>(`/connections/${id}/reconnect`, { method: "POST" }),

  checkHealth: (id: string) =>
    request<{ healthy: boolean; message: string }>(`/connections/${id}/health`),

  submitIntegrationRequest: (data: {
    manufacturer_name: string;
    fleet_size: number;
    desired_categories: string[];
    contact_notes?: string;
  }) => request<any>("/integration-requests", { method: "POST", body: JSON.stringify(data) }),

  getIntegrationRequests: () => request<{ requests: any[] }>("/integration-requests"),

  getQuarantineIncidents: (status?: string) => {
    const q = status ? `?status=${status}` : "";
    return request<{ incidents: any[] }>(`/quarantine/incidents${q}`);
  },

  getQuarantineIncident: (id: string) => request<{ incident: any }>(`/quarantine/incidents/${id}`),

  getIncidentVehicles: (id: string) => request<{ vehicles: any[] }>(`/quarantine/incidents/${id}/vehicles`),

  acknowledgeIncident: (id: string) =>
    request<{ success: boolean }>(`/quarantine/incidents/${id}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ acknowledged_by: "fleet_manager" }),
    }),

  retryIncident: (id: string, mappingProfileId?: string) =>
    request<{ success: boolean; jobId?: string; message?: string }>(`/quarantine/incidents/${id}/retry`, {
      method: "POST",
      body: JSON.stringify(mappingProfileId ? { mapping_profile_id: mappingProfileId } : {}),
    }),

  getQuarantineRecords: (params: { incident_id?: string; vehicle_id?: string; status?: string }) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as any
    ).toString();
    return request<{ records: any[] }>(`/quarantine/records${q ? "?" + q : ""}`);
  },

  getQuarantineSummary: () => request<any>("/quarantine/summary"),

  getVehicleDetail: (vehicleId: string) => request<any>(`/vehicles/${vehicleId}/detail`),
  getBackendJobs: () => request<any>('/backend-jobs'),
  getTripBundle: (vehicleId: string, tripId: string) => request<any>(`/vehicles/${vehicleId}/trips/${tripId}/bundle`),

  getVehicleTrips: (vehicleId: string, from?: string, to?: string, offset=0) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if(offset) params.set('offset',String(offset));
    const q = params.toString();
    return request<{ trips: any[];hasMore?:boolean;nextOffset?:number|null }>(`/vehicles/${vehicleId}/trips${q ? "?" + q : ""}`);
  },

  getTripRoute: (vehicleId: string, tripId: string) =>
    request<any>(`/vehicles/${vehicleId}/trips/${tripId}/route`),

  getTripEvents: (vehicleId: string, tripId: string, eventType?: string) => {
    const q = eventType ? `?event_type=${eventType}` : "";
    return request<{ events: any[] }>(`/vehicles/${vehicleId}/trips/${tripId}/events${q}`);
  },

  getTripQuality: (vehicleId: string, tripId: string) =>
    request<any>(`/vehicles/${vehicleId}/trips/${tripId}/quality`),
};
