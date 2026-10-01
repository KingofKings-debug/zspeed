import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, fileURLToPath(new URL("..", import.meta.url)), "");
  const uiEnv = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_");
  const target = process.env.VITE_SIMULATOR_BACKEND_URL || uiEnv.VITE_SIMULATOR_BACKEND_URL ||
    `http://127.0.0.1:${process.env.SIMULATOR_PORT || rootEnv.SIMULATOR_PORT || "3002"}`;
  const adminKey = process.env.SIMULATOR_ADMIN_KEY || rootEnv.SIMULATOR_ADMIN_KEY ||
    process.env.VITE_SIMULATOR_ADMIN_KEY || uiEnv.VITE_SIMULATOR_ADMIN_KEY || "sim-admin-secret-2026";
  return {
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
      proxy: {
        "/api/simulator": {
          target,
          changeOrigin: true,
          headers: { "X-Simulator-Admin-Key": adminKey },
        },
        "/oem": {
          target,
          changeOrigin: true,
        },
      },
    },
  };
});
