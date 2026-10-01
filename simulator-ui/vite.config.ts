import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.VITE_SIMULATOR_BACKEND_URL || "http://localhost:3002";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      "/api/simulator": {
        target,
        changeOrigin: true,
      },
      "/oem": {
        target,
        changeOrigin: true,
      },
    },
  },
});
