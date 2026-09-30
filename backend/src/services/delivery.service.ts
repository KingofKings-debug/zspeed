import { ingestEvent } from "./ingestion.service.js";
import { query, queryOne, run } from "../db/pool.js";

interface ActiveDelivery {
  connectionId: string;
  fleetId: string;
  oemId: string;
  intervalId: NodeJS.Timeout | null;
  backoffUntil: number;
  consecutiveFailures: number;
  token?: string;
  tokenExpiresAt?: number;
}

const activeDeliveries = new Map<string, ActiveDelivery>();

function getOemBaseUrl(oemId: string): string {
  if (oemId === "oem_voltera") {
    return process.env.VOLTERA_BASE_URL || "http://127.0.0.1:3002/oem/voltera";
  }
  if (oemId === "oem_crestline") {
    return process.env.CRUX_BASE_URL || process.env.CRESTLINE_BASE_URL || "http://127.0.0.1:3002/oem/crestline";
  }
  if (oemId === "oem_navarro") {
    return process.env.NAVARRO_BASE_URL || "http://127.0.0.1:3002/oem/navarro";
  }
  return "http://127.0.0.1:3002";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getOrFetchVolteraToken(delivery: ActiveDelivery): Promise<string | null> {
  if (delivery.token && delivery.tokenExpiresAt && Date.now() < delivery.tokenExpiresAt - 60000) {
    return delivery.token;
  }

  const baseUrl = getOemBaseUrl(delivery.oemId);
  try {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "fleet_admin",
        password: "valid_password",
      }),
      signal: AbortSignal.timeout(2000),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      if (typeof data.access_token === "string") {
        delivery.token = data.access_token;
        delivery.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
        return delivery.token || null;
      }
    }
  } catch {}

  return null;
}

function generateDemoPayload(oemId: string, _vehicleId: string, index: number): any {
  const now = new Date().toISOString();
  if (oemId === "oem_voltera") {
    return {
      timestamp: now,
      speed_mph: 25 + (index % 30),
      charge_fraction: 0.8,
      odo_miles: 12000 + index,
      status: "running",
      lat: 51.5074 + (index % 10) * 0.001,
      lon: -0.1278 + (index % 10) * 0.001,
      altitude: 20,
      heading: 90,
      harsh_brake: false,
    };
  }

  if (oemId === "oem_crestline") {
    return {
      velocity_kmh: 40 + (index % 40),
      battery_pct: 75,
      distance_km: 15000 + index,
      ignition: true,
      gps_lat: 51.5074 + (index % 10) * 0.001,
      gps_lon: -0.1278 + (index % 10) * 0.001,
      gps_heading: 90,
      harsh_braking: false,
      charging: false,
      time_measured: Date.now(),
    };
  }

  return {
    timestamp: now,
    speed: 30,
    lat: 51.5074,
    lon: -0.1278,
  };
}

export async function pollConnectionBatchAsync(connectionId: string): Promise<number> {
  const delivery = activeDeliveries.get(connectionId);
  if (!delivery) return 0;

  if (Date.now() < delivery.backoffUntil) {
    return 0;
  }

  const mappings = query<{ oem_vehicle_id: string }>(
    "SELECT oem_vehicle_id FROM vehicle_source_mappings WHERE connection_id = ? AND is_verified = 1",
    [connectionId]
  );
  if (mappings.length === 0) return 0;

  const baseUrl = getOemBaseUrl(delivery.oemId);
  let delivered = 0;
  let hitRateLimit = false;
  let encounteredNetworkError = false;

  const batchSize = 3;
  for (let i = 0; i < mappings.length; i += batchSize) {
    const chunk = mappings.slice(i, i + batchSize);

    const chunkResults = await Promise.all(
      chunk.map(async (mapping, chunkIndex) => {
        const jitterMs = Math.floor(Math.random() * 30) + chunkIndex * 20;
        await delay(jitterMs);

        const oemVehicleId = mapping.oem_vehicle_id;

        const cursorRow = queryOne<{ cursor: string }>(
          "SELECT cursor FROM connector_cursors WHERE connection_id = ? AND vehicle_id = ?",
          [connectionId, oemVehicleId]
        );
        const currentCursor = cursorRow?.cursor || null;

        try {
          if (delivery.oemId === "oem_voltera") {
            const token = await getOrFetchVolteraToken(delivery);
            const headers: Record<string, string> = {};
            if (token) headers["Authorization"] = `Bearer ${token}`;

            let url = `${baseUrl}/v1/vehicles/${oemVehicleId}/telemetry/latest`;
            if (currentCursor) {
              url = `${baseUrl}/v1/vehicles/${oemVehicleId}/telemetry/history?cursor=${encodeURIComponent(currentCursor)}&limit=50`;
            }

            const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });

            if (res.status === 429) {
              hitRateLimit = true;
              const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
              delivery.backoffUntil = Date.now() + retryAfter * 1000;
              return 0;
            }

            if (res.ok) {
              const data = (await res.json()) as any;
              let itemsDelivered = 0;

              if (data.events && Array.isArray(data.events)) {
                if (data.events.length === 0 && currentCursor) {
                  try {
                    const latestRes = await fetch(`${baseUrl}/v1/vehicles/${oemVehicleId}/telemetry/latest`, {
                      headers,
                      signal: AbortSignal.timeout(3000),
                    });
                    if (latestRes.ok) {
                      const latestData = (await latestRes.json()) as any;
                      const parsedCur = parseInt(currentCursor, 10);
                      if (latestData.sequence !== undefined && (isNaN(parsedCur) || latestData.sequence < parsedCur)) {
                        run(
                          `INSERT INTO connector_cursors (connection_id, vehicle_id, cursor, last_polled_at)
                           VALUES (?, ?, ?, datetime('now'))
                           ON CONFLICT(connection_id, vehicle_id) DO UPDATE SET cursor = ?, last_polled_at = datetime('now')`,
                          [connectionId, oemVehicleId, String(latestData.sequence), String(latestData.sequence)]
                        );
                        if (latestData.payload) {
                          const ingestRes = ingestEvent(
                            delivery.fleetId,
                            connectionId,
                            oemVehicleId,
                            latestData.payload,
                            latestData.event_id || null,
                            true
                          );
                          if (ingestRes.status === "ACCEPTED" || ingestRes.status === "PROCESSED") {
                            itemsDelivered++;
                          }
                        }
                      }
                    }
                  } catch {}
                }

                for (const ev of data.events) {
                  const ingestRes = ingestEvent(
                    delivery.fleetId,
                    connectionId,
                    oemVehicleId,
                    ev.payload,
                    ev.event_id || null,
                    true
                  );
                  if (ingestRes.status === "ACCEPTED" || ingestRes.status === "PROCESSED") {
                    itemsDelivered++;
                  }
                }
                if (data.next_cursor) {
                  run(
                    `INSERT INTO connector_cursors (connection_id, vehicle_id, cursor, last_polled_at)
                     VALUES (?, ?, ?, datetime('now'))
                     ON CONFLICT(connection_id, vehicle_id) DO UPDATE SET cursor = ?, last_polled_at = datetime('now')`,
                    [connectionId, oemVehicleId, data.next_cursor, data.next_cursor]
                  );
                }
              } else if (data.payload) {
                const ingestRes = ingestEvent(
                  delivery.fleetId,
                  connectionId,
                  oemVehicleId,
                  data.payload,
                  data.event_id || null,
                  true
                );
                if (ingestRes.status === "ACCEPTED" || ingestRes.status === "PROCESSED") {
                  itemsDelivered++;
                }
                if (data.sequence !== undefined) {
                  run(
                    `INSERT INTO connector_cursors (connection_id, vehicle_id, cursor, last_polled_at)
                     VALUES (?, ?, ?, datetime('now'))
                     ON CONFLICT(connection_id, vehicle_id) DO UPDATE SET cursor = ?, last_polled_at = datetime('now')`,
                    [connectionId, oemVehicleId, String(data.sequence), String(data.sequence)]
                  );
                }
              }
              return itemsDelivered;
            }
          }

          if (delivery.oemId === "oem_crestline") {
            const headers = { "X-API-Key": "crestline_live_key" };
            let url = `${baseUrl}/v1/vehicles/${oemVehicleId}/feed`;
            if (currentCursor) {
              url = `${baseUrl}/v1/vehicles/${oemVehicleId}/history?cursor=${encodeURIComponent(currentCursor)}&limit=50`;
            }

            const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });

            if (res.status === 429) {
              hitRateLimit = true;
              const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
              delivery.backoffUntil = Date.now() + retryAfter * 1000;
              return 0;
            }

            if (res.ok) {
              const data = (await res.json()) as any;
              let itemsDelivered = 0;

              if (data.data && Array.isArray(data.data)) {
                if (data.data.length === 0 && currentCursor) {
                  try {
                    const feedRes = await fetch(`${baseUrl}/v1/vehicles/${oemVehicleId}/feed`, {
                      headers,
                      signal: AbortSignal.timeout(3000),
                    });
                    if (feedRes.ok) {
                      const feedData = (await feedRes.json()) as any;
                      const parsedCur = parseInt(currentCursor, 10);
                      const seq = feedData.sequence || feedData.pagination?.next_cursor;
                      if (seq !== undefined && (isNaN(parsedCur) || Number(seq) < parsedCur)) {
                        run(
                          `INSERT INTO connector_cursors (connection_id, vehicle_id, cursor, last_polled_at)
                           VALUES (?, ?, ?, datetime('now'))
                           ON CONFLICT(connection_id, vehicle_id) DO UPDATE SET cursor = ?, last_polled_at = datetime('now')`,
                          [connectionId, oemVehicleId, String(seq), String(seq)]
                        );
                        const ingestRes = ingestEvent(
                          delivery.fleetId,
                          connectionId,
                          oemVehicleId,
                          feedData.payload || feedData,
                          feedData.event_id || null,
                          true
                        );
                        if (ingestRes.status === "ACCEPTED" || ingestRes.status === "PROCESSED") {
                          itemsDelivered++;
                        }
                      }
                    }
                  } catch {}
                }

                for (const item of data.data) {
                  const ingestRes = ingestEvent(
                    delivery.fleetId,
                    connectionId,
                    oemVehicleId,
                    item.payload || item,
                    item.event_id || null,
                    true
                  );
                  if (ingestRes.status === "ACCEPTED" || ingestRes.status === "PROCESSED") {
                    itemsDelivered++;
                  }
                }
                if (data.pagination?.next_cursor) {
                  run(
                    `INSERT INTO connector_cursors (connection_id, vehicle_id, cursor, last_polled_at)
                     VALUES (?, ?, ?, datetime('now'))
                     ON CONFLICT(connection_id, vehicle_id) DO UPDATE SET cursor = ?, last_polled_at = datetime('now')`,
                    [connectionId, oemVehicleId, data.pagination.next_cursor, data.pagination.next_cursor]
                  );
                }
              } else {
                const ingestRes = ingestEvent(
                  delivery.fleetId,
                  connectionId,
                  oemVehicleId,
                  data,
                  data.event_id || null,
                  true
                );
                if (ingestRes.status === "ACCEPTED" || ingestRes.status === "PROCESSED") {
                  itemsDelivered++;
                }
                if (data.sequence !== undefined) {
                  run(
                    `INSERT INTO connector_cursors (connection_id, vehicle_id, cursor, last_polled_at)
                     VALUES (?, ?, ?, datetime('now'))
                     ON CONFLICT(connection_id, vehicle_id) DO UPDATE SET cursor = ?, last_polled_at = datetime('now')`,
                    [connectionId, oemVehicleId, String(data.sequence), String(data.sequence)]
                  );
                }
              }
              return itemsDelivered;
            }
          }

          if (delivery.oemId === "oem_navarro") {
            const url = `${baseUrl}/v1/vehicles/${oemVehicleId}/telemetry`;
            const res = await fetch(url, { signal: AbortSignal.timeout(3000) });

            if (res.status === 429) {
              hitRateLimit = true;
              const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
              delivery.backoffUntil = Date.now() + retryAfter * 1000;
              return 0;
            }

            if (res.ok) {
              const data = (await res.json()) as any;
              let itemsDelivered = 0;
              if (data.payload) {
                const ingestRes = ingestEvent(
                  delivery.fleetId,
                  connectionId,
                  oemVehicleId,
                  data.payload,
                  data.event_id || null,
                  true
                );
                if (ingestRes.status === "ACCEPTED" || ingestRes.status === "PROCESSED") {
                  itemsDelivered++;
                }
                if (data.sequence !== undefined) {
                  run(
                    `INSERT INTO connector_cursors (connection_id, vehicle_id, cursor, last_polled_at)
                     VALUES (?, ?, ?, datetime('now'))
                     ON CONFLICT(connection_id, vehicle_id) DO UPDATE SET cursor = ?, last_polled_at = datetime('now')`,
                    [connectionId, oemVehicleId, String(data.sequence), String(data.sequence)]
                  );
                }
              }
              return itemsDelivered;
            }
          }
        } catch {
          encounteredNetworkError = true;
        }

        const fallbackPayload = generateDemoPayload(delivery.oemId, oemVehicleId, i + 1);
        try {
          const res = ingestEvent(delivery.fleetId, connectionId, oemVehicleId, fallbackPayload);
          return res.status === "PROCESSED" || res.status === "ACCEPTED" ? 1 : 0;
        } catch {
          return 0;
        }
      })
    );

    for (const count of chunkResults) {
      delivered += count;
    }

    if (hitRateLimit) {
      break;
    }
  }

  if (!encounteredNetworkError) {
    delivery.consecutiveFailures = 0;
  } else if (!hitRateLimit) {
    delivery.consecutiveFailures++;
    if (delivery.consecutiveFailures > 3) {
      const backoffSec = Math.min(30, Math.pow(2, delivery.consecutiveFailures - 3));
      delivery.backoffUntil = Date.now() + backoffSec * 1000;
    }
  }

  return delivered;
}

export function deliverBatch(connectionId: string): number {
  const delivery = activeDeliveries.get(connectionId);
  if (!delivery) return 0;

  const mappings = query<{ oem_vehicle_id: string }>(
    "SELECT oem_vehicle_id FROM vehicle_source_mappings WHERE connection_id = ? AND is_verified = 1",
    [connectionId]
  );

  let delivered = 0;
  for (let i = 0; i < mappings.length; i++) {
    const oemVehicleId = mappings[i].oem_vehicle_id;
    const payload = generateDemoPayload(delivery.oemId, oemVehicleId, i + 1);
    try {
      const res = ingestEvent(delivery.fleetId, connectionId, oemVehicleId, payload);
      if (res.status === "PROCESSED" || res.status === "ACCEPTED") {
        delivered++;
      }
    } catch {}
  }

  return delivered;
}

export function startDemoDelivery(
  connectionId: string,
  fleetId: string,
  oemId: string,
  intervalMs = 1500
): void {
  stopDemoDelivery(connectionId);

  const delivery: ActiveDelivery = {
    connectionId,
    fleetId,
    oemId,
    intervalId: null,
    backoffUntil: 0,
    consecutiveFailures: 0,
  };

  delivery.intervalId = setInterval(() => {
    pollConnectionBatchAsync(connectionId).catch(() => {});
  }, intervalMs);

  activeDeliveries.set(connectionId, delivery);
}

export function stopDemoDelivery(connectionId: string): void {
  const existing = activeDeliveries.get(connectionId);
  if (existing) {
    if (existing.intervalId) {
      clearInterval(existing.intervalId);
    }
    activeDeliveries.delete(connectionId);
  }
}

export function isDeliveryActive(connectionId: string): boolean {
  return activeDeliveries.has(connectionId);
}

export function initializeDeliveries(): void {
  try {
    const activeConnections = query<{ id: string; fleet_id: string; oem_id: string }>(
      "SELECT id, fleet_id, oem_id FROM oem_connections WHERE status = 'ACTIVE'"
    );
    for (const conn of activeConnections) {
      startDemoDelivery(conn.id, conn.fleet_id, conn.oem_id, 1500);
    }
  } catch {}
}
