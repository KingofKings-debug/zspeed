import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, fileURLToPath(new URL("..", import.meta.url)), "");
  const target = `http://127.0.0.1:${process.env.PORT || rootEnv.PORT || "3001"}`;
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
        },
        "/socket.io": {
          target,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
