import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const { compilerOptions } = JSON.parse(await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"));
// Use the existing build tool to load TypeScript and repository aliases on Node.
// No browser framework, client bundle, live provider or outbound request is needed.
const vite = await createViteServer({
  root, configFile: false, appType: "custom", logLevel: "error",
  resolve: { alias: Object.fromEntries(Object.entries(compilerOptions.paths).map(([name, [path]]) => [name, root + path])) },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false, host: "127.0.0.1" },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const port = Number(process.env.ROAMIO_DEMO_PORT ?? "4173");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("ROAMIO_DEMO_PORT must be an integer from 1024 to 65535");
const server = createServer(async (request, response) => {
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end("GET only"); return; }
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/styles.css") {
      response.setHeader("Content-Type", "text/css; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : await readFile(new URL("styles.css", import.meta.url))); return;
    }
    if (url.pathname !== "/") { response.writeHead(404); response.end("Not found"); return; }
    const { renderDemo } = await vite.ssrLoadModule("/demo/view.ts");
    const state = await readFile(new URL("../docs/CURRENT_STATE.md", import.meta.url), "utf8");
    const html = renderDemo(state, url.searchParams.get("scenario"), url.searchParams.get("budget"));
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(request.method === "HEAD" ? undefined : html);
  } catch (error) {
    console.error(error);
    response.writeHead(500); response.end("Demo failed to render. Inspect the local terminal.");
  }
});
server.on("error", async error => { console.error(error.message); await vite.close(); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`Roamio Core Intelligence Demo: http://127.0.0.1:${port}\nSynthetic canonical data only. Press Ctrl+C to stop.`));
const close = () => { server.close(); void vite.close(); };
process.once("SIGINT", close); process.once("SIGTERM", close);
