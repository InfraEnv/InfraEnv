import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/app/",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  server: {
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:7331",
      "/v1": "http://127.0.0.1:8080"
    }
  }
});
