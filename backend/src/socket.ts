import { Server, Socket } from "socket.io";
import type { Server as HTTPServer } from "http";
import { config } from "./config.js";
import { getCatchupEvents } from "./services/fleet-event.service.js";

let io: Server;

function extractFleetAuth(socket: Socket): { fleetId: string; role: string } | null {
  const rawAuth = socket.handshake.auth || {};
  const headers = socket.handshake.headers || {};

  const token =
    rawAuth.token ||
    (typeof headers.authorization === "string" ? headers.authorization : null);

  if (token) {
    const cleanToken = token.startsWith("Bearer ") ? token.slice(7) : token;
    if (cleanToken.startsWith("demo:")) {
      const parts = cleanToken.split(":");
      if (parts.length >= 3) {
        return { fleetId: parts[1], role: parts[2] };
      }
    }
  }

  if (rawAuth.fleetId) {
    return { fleetId: String(rawAuth.fleetId), role: rawAuth.role || "fleet_manager" };
  }

  const headerFleet = headers["x-fleet-id"];
  if (typeof headerFleet === "string" && headerFleet.trim().length > 0) {
    return { fleetId: headerFleet.trim(), role: "fleet_manager" };
  }

  if (config.demoMode) {
    return { fleetId: config.defaultFleetId, role: "fleet_manager" };
  }

  return null;
}

export function initSocket(server: HTTPServer): Server {
  io = new Server(server, {
    cors: {
      origin: config.corsOrigin,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const auth = extractFleetAuth(socket);
    if (!auth || !auth.fleetId) {
      return next(new Error("Authentication error"));
    }
    socket.data.fleetId = auth.fleetId;
    socket.data.role = auth.role;
    next();
  });

  io.on("connection", (socket) => {
    const fleetId = socket.data.fleetId;
    socket.join(`fleet:${fleetId}`);

    socket.emit("connected", {
      fleetId,
      socketId: socket.id,
      timestamp: new Date().toISOString(),
    });

    socket.on("subscribe:fleet", () => {
      socket.join(`fleet:${fleetId}`);
    });

    socket.on("unsubscribe:fleet", () => {
      socket.leave(`fleet:${fleetId}`);
    });

    socket.on("subscribe:vehicle", (vehicleId: string) => {
      if (vehicleId) {
        socket.join(`vehicle:${fleetId}:${vehicleId}`);
      }
    });

    socket.on("unsubscribe:vehicle", (vehicleId: string) => {
      if (vehicleId) {
        socket.leave(`vehicle:${fleetId}:${vehicleId}`);
      }
    });

    socket.on("catchup", (data: { since?: number; limit?: number }, callback?: (res: any) => void) => {
      const since = Number(data?.since) || 0;
      const limit = Math.min(Number(data?.limit) || 100, 500);
      const result = getCatchupEvents(fleetId, since, limit);
      if (typeof callback === "function") {
        callback(result);
      } else {
        socket.emit("catchup:events", result);
      }
    });
  });

  return io;
}

export function getIo(): Server {
  if (!io) {
    throw new Error("Socket.io not initialized!");
  }
  return io;
}
