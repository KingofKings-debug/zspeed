import { io, Socket } from "socket.io-client";
import type { FleetSocketMessage } from "./types";
import { vehicleStore } from "./store/vehicleStore";
import { getToken, getSession, getApiBase } from "./session";

const SOCKET_URL = (import.meta as any).env?.VITE_SOCKET_URL || (import.meta as any).env?.VITE_API_URL || undefined;

let socket: Socket | null = null;
let lastContiguousSequence = 0;
let currentFleetId = "fleet_demo_001";
let currentTrackedVehicleId: string | null = null;
let isCatchingUp = false;

const listeners = new Set<(msg: FleetSocketMessage) => void>();
const processedMessageIds = new Set<string>();
const messageBuffer = new Map<number, FleetSocketMessage>();

export function getFleetSocket(): Socket {
  if (!socket) {
    const token = getToken();
    const session = getSession();
    const authData: Record<string, string> = { fleetId: currentFleetId };
    if (token) {
      authData.token = token;
    }
    if (session?.fleetId) {
      authData.fleetId = session.fleetId;
      currentFleetId = session.fleetId;
    }

    socket = io(SOCKET_URL, {
      auth: authData,
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
    });

    socket.on("connect", () => {
      vehicleStore.setConnectionState("connected");
      if (lastContiguousSequence > 0) {
        syncCatchup();
      }
      if (currentTrackedVehicleId) {
        socket?.emit("subscribe:vehicle", currentTrackedVehicleId);
      }
    });

    socket.on("disconnect", () => {
      vehicleStore.setConnectionState("disconnected");
    });

    socket.on("connect_error", () => {
      vehicleStore.setConnectionState("reconnecting");
    });

    socket.on("fleet:event", (msg: FleetSocketMessage) => {
      handleIncomingMessage(msg);
    });
  }

  return socket;
}

export function disconnectFleetSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  lastContiguousSequence = 0;
  isCatchingUp = false;
  currentTrackedVehicleId = null;
  messageBuffer.clear();
  processedMessageIds.clear();
  vehicleStore.setConnectionState("disconnected");
}

export function setAuthenticatedFleet(fleetId: string): void {
  const fleetChanged = fleetId !== currentFleetId;
  currentFleetId = fleetId;

  if (fleetChanged || !socket) {
    lastContiguousSequence = 0;
    messageBuffer.clear();
    processedMessageIds.clear();
    vehicleStore.reset();

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    getFleetSocket();
  }
}

function applyMessage(msg: FleetSocketMessage): void {
  if (msg.eventType === "vehicle:telemetry") {
    vehicleStore.applyLiveUpdate(msg);
  }

  listeners.forEach((listener) => {
    try {
      listener(msg);
    } catch (err) {
      console.error(err);
    }
  });
}

function drainContiguousBuffer(): void {
  while (messageBuffer.has(lastContiguousSequence + 1)) {
    const nextSeq = lastContiguousSequence + 1;
    const nextMsg = messageBuffer.get(nextSeq)!;
    messageBuffer.delete(nextSeq);
    lastContiguousSequence = nextSeq;
    applyMessage(nextMsg);
  }
}

function handleIncomingMessage(msg: FleetSocketMessage) {
  if (!msg || typeof msg.sequence !== "number") return;

  const dedupKey = msg.id || `${msg.eventType}:${msg.sequence}`;
  if (processedMessageIds.has(dedupKey)) {
    return;
  }
  processedMessageIds.add(dedupKey);
  if (processedMessageIds.size > 2000) {
    const oldest = processedMessageIds.values().next().value;
    if (oldest) processedMessageIds.delete(oldest);
  }

  if (lastContiguousSequence === 0) {
    lastContiguousSequence = msg.sequence;
    applyMessage(msg);
    drainContiguousBuffer();
    return;
  }

  if (msg.sequence <= lastContiguousSequence) {
    return;
  }

  if (msg.sequence === lastContiguousSequence + 1) {
    lastContiguousSequence = msg.sequence;
    applyMessage(msg);
    drainContiguousBuffer();
    return;
  }

  messageBuffer.set(msg.sequence, msg);
  syncCatchup();
}

export async function syncCatchup(): Promise<void> {
  if (!socket || !socket.connected || isCatchingUp) return;
  isCatchingUp = true;

  try {
    let hasMore = true;
    let paginationSafety = 100;

    while (hasMore && paginationSafety-- > 0) {
      const since = lastContiguousSequence;
      const res: any = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Catchup timeout")), 6000);
        socket!.emit(
          "catchup",
          { since, limit: 500 },
          (response?: { events?: FleetSocketMessage[]; reset?: boolean; latestSequence?: number }) => {
            clearTimeout(timeout);
            resolve(response);
          }
        );
      });

      if (!res || res.reset) {
        await fetchSnapshotFallback();
        break;
      }

      const events: FleetSocketMessage[] = Array.isArray(res.events) ? res.events : [];
      if (events.length === 0) {
        hasMore = false;
        break;
      }

      events.sort((a, b) => a.sequence - b.sequence);

      for (const evt of events) {
        const dedupKey = evt.id || `${evt.eventType}:${evt.sequence}`;
        if (!processedMessageIds.has(dedupKey)) {
          processedMessageIds.add(dedupKey);
          if (evt.sequence === lastContiguousSequence + 1 || lastContiguousSequence === 0) {
            lastContiguousSequence = evt.sequence;
            applyMessage(evt);
          } else if (evt.sequence > lastContiguousSequence + 1) {
            messageBuffer.set(evt.sequence, evt);
          }
        }
      }

      drainContiguousBuffer();

      if (events.length < 500) {
        hasMore = false;
      }
    }
  } catch {
    await fetchSnapshotFallback();
  } finally {
    isCatchingUp = false;
  }
}

async function fetchSnapshotFallback(): Promise<void> {
  try {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    } else {
      headers["x-fleet-id"] = currentFleetId;
    }

    const res = await fetch(`${getApiBase()}/vehicles`, { headers });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.vehicles)) {
        vehicleStore.initSnapshot(data.vehicles, data.snapshotVersion);
        if (typeof data.snapshotVersion === "number" && data.snapshotVersion > lastContiguousSequence) {
          lastContiguousSequence = data.snapshotVersion;
        }
        messageBuffer.clear();
      }
    }
  } catch (err) {
    console.error("Snapshot fallback error:", err);
  }
}

export function subscribeToFleetEvents(listener: (msg: FleetSocketMessage) => void): () => void {
  getFleetSocket();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeVehicleTracking(vehicleId: string) {
  const s = getFleetSocket();
  if (currentTrackedVehicleId && currentTrackedVehicleId !== vehicleId) {
    s.emit("unsubscribe:vehicle", currentTrackedVehicleId);
  }
  currentTrackedVehicleId = vehicleId;
  s.emit("subscribe:vehicle", vehicleId);
}

export function unsubscribeVehicleTracking(vehicleId: string) {
  const s = getFleetSocket();
  if (currentTrackedVehicleId === vehicleId) {
    currentTrackedVehicleId = null;
  }
  s.emit("unsubscribe:vehicle", vehicleId);
}

export function getSocketState() {
  return {
    connected: socket?.connected ?? false,
    lastSequence: lastContiguousSequence,
    isCatchingUp,
    bufferedMessagesCount: messageBuffer.size,
  };
}
