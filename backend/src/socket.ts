import { Server, Socket } from "socket.io";
import type { Server as HTTPServer } from "http";
import { config } from "./config.js";
import { getCatchupEvents } from "./services/fleet-event.service.js";
import { verifyAuthToken, AuthIdentity } from "./middleware/fleet.js";
import { queryOne } from "./db/pool.js";

let io: Server;

function extractFleetAuth(socket: Socket): AuthIdentity | null {
  const rawAuth = socket.handshake.auth || {};
  const headers = socket.handshake.headers || {};

  const rawToken =
    rawAuth.token ||
    (typeof headers.authorization === "string" ? headers.authorization : null);

  if (rawToken && typeof rawToken === "string") {
    try {
      return verifyAuthToken(rawToken);
    } catch {
      return null;
    }
  }

  if (config.demoMode) {
    if (rawAuth.fleetId && typeof rawAuth.fleetId === "string") {
      return {
        userId: `demo_${rawAuth.fleetId}_user`,
        fleetId: String(rawAuth.fleetId),
        role: (rawAuth.role as any) || "fleet_manager",
      };
    }
    const headerFleet = headers["x-fleet-id"];
    if (typeof headerFleet === "string" && headerFleet.trim().length > 0) {
      return {
        userId: `demo_${headerFleet.trim()}_user`,
        fleetId: headerFleet.trim(),
        role: "fleet_manager",
      };
    }
    return {
      userId: "demo_user",
      fleetId: config.defaultFleetId,
      role: "fleet_manager",
    };
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
      return next(new Error("Authentication error: Unauthorized"));
    }
    socket.data.fleetId = auth.fleetId;
    socket.data.role = auth.role;
    socket.data.userId = auth.userId;
    next();
  });

  io.on("connection", (socket) => {
    const fleetId = socket.data.fleetId as string;
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
      if (!vehicleId) return;
      const vehicle = queryOne<{ id: string }>(
        "SELECT id FROM vehicles WHERE id = ? AND fleet_id = ?",
        [vehicleId, fleetId]
      );
      if (vehicle) {
        socket.join(`vehicle:${fleetId}:${vehicleId}`);
      } else {
        socket.emit("subscription:error", {
          message: "Vehicle not found or unauthorized",
          vehicleId,
        });
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
