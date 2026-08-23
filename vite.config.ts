import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The AudioWorklet is the one asset Vite cannot fingerprint: it is loaded by
 * URL at runtime, not imported, so it keeps a fixed name across deploys while
 * every hashed bundle around it changes. A browser holding the old copy then
 * runs new application code against an old audio engine -- which is exactly
 * how a device ends up silently out of sync with everyone else. Hashing its
 * contents into the query string makes a stale worklet impossible.
 */
const workletHash = createHash("sha256")
  .update(readFileSync("public/live-processor.js"))
  .digest("hex")
  .slice(0, 12);

export default defineConfig({
  define: { __WORKLET_VERSION__: JSON.stringify(workletHash) },
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist/client", emptyOutDir: true, target: "es2022" },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
