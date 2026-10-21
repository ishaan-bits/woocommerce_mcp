import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The dashboard always calls *relative* `/api/...` paths: in development the
 * Vite proxy forwards them to the gateway (VITE_GATEWAY_API_URL, default
 * http://127.0.0.1:8080), so the browser only ever talks same-origin — no
 * CORS changes in the gateway, and no gateway URL (or any environment
 * configuration) is ever baked into the client bundle.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_GATEWAY_API_URL || "http://127.0.0.1:8080";
  const proxy = {
    "/api": {
      target,
      changeOrigin: true,
    },
  };
  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
    build: { outDir: "dist", sourcemap: false },
  };
});
