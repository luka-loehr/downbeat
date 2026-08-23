import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist/client", emptyOutDir: true, target: "es2022" },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
