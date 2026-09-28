import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig({
  root: path.resolve("cloudflare/web"),
  plugins: [react()],
  build: {
    outDir: path.resolve("cloudflare/dist"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: { charts: ["recharts"], react: ["react", "react-dom"] },
      },
    },
  },
  server: { port: 5174, proxy: { "/api": "http://localhost:8787" } },
});
