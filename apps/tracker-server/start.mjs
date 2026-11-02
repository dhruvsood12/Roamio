import { build } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (existsSync(resolve(root, ".env")))
  process.loadEnvFile(resolve(root, ".env"));
// Build then serve only compiled browser assets. No dev-server filesystem endpoints.
await build({
  configFile: false,
  root: resolve(root, "apps/tracker-web"),
  logLevel: "warn",
  build: { outDir: resolve(root, "dist/tracker/web"), emptyOutDir: true },
});
await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    ssr: resolve(root, "apps/tracker-server/entry.ts"),
    outDir: resolve(root, "dist/tracker/server"),
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "entry.mjs" } },
  },
});
const { start } = await import(
  pathToFileURL(resolve(root, "dist/tracker/server/entry.mjs")).href
);
await start(resolve(root, "dist/tracker/web"));
