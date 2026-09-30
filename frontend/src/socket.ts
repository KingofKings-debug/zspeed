import { io, Socket } from "socket.io-client";
import type { FleetSocketMessage } from "./types";
import { vehicleStore } from "./store/vehicleStore";

let socket: Socket | null = null;
let lastSequence = 0;
let currentTrackedVehicleId: string | null = null;
const listeners = new Set<(msg: FleetSocketMessage) => void>();
const processedMessageIds = new Set<string>();

export function getFleetSocket(): Socket {
  if (!socket) {
    socket = io({
      auth: { fleetId: "fleet_demo_001" },
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
    });

    socket.on("connect", () => {
      vehicleStore.setConnectionState("connected");
      if (lastSequence > 0) {
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

function handleIncomingMessage(msg: FleetSocketMessage) {
  if (!msg || typeof msg.sequence !== "number") return;

  const dedupKey = msg.id || `${msg.eventType}:${msg.sequence}`;
  if (processedMessageIds.has(dedupKey)) {
    return;
  }
  processedMessageIds.add(dedupKey);
  if (processedMessageIds.size > 500) {
    const oldest = processedMessageIds.values().next().value;
    if (oldest) processedMessageIds.delete(oldest);
  }

  if (lastSequence > 0 && msg.sequence > lastSequence + 1) {
    syncCatchup();
  }

  if (msg.sequence > lastSequence) {
    lastSequence = msg.sequence;
  }

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

export function syncCatchup() {
  if (!socket || !socket.connected) return;
  const since = lastSequence;
  socket.emit("catchup", { since }, (response?: { events: FleetSocketMessage[] }) => {
    if (response?.events && Array.isArray(response.events)) {
      response.events.forEach((msg) => {
        handleIncomingMessage(msg);
      });
    }
  });
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
    lastSequence,
  };
}
