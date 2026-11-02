import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createApi } from "./http";
import { createTrackerService } from "./service";
import { createFlightAwareProvider } from "./flightaware";
import { createDemoProvider } from "./demo";

export async function start(staticDirectory: string) {
  const mode = process.env.TRACKER_PROVIDER ?? "demo";
  if (mode !== "demo" && mode !== "flightaware")
    throw new Error("TRACKER_PROVIDER must be demo or flightaware.");
  const provider =
    mode === "demo"
      ? createDemoProvider()
      : createFlightAwareProvider(process.env.FLIGHTAWARE_API_KEY);
  const service = createTrackerService(provider),
    api = createApi(service);
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    // Bind loopback and reject DNS-rebinding hosts; no cross-origin proxy or CORS.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) {
      res.writeHead(403);
      res.end("Local access only");
      return;
    }
    if (req.url?.startsWith("/api/")) {
      await api(req, res);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      let name: string;
      if (path === "/" || /^\/flight\/[^/]+\/[^/]+\/?$/.test(path))
        name = "index.html";
      else if (
        /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(path) ||
        path === "/world.svg" ||
        path === "/favicon.svg"
      )
        name = path.slice(1);
      else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const file = resolve(staticDirectory, name);
      if (!file.startsWith(resolve(staticDirectory) + sep))
        throw new Error("Invalid path");
      const body = await readFile(file),
        extension = file.split(".").pop();
      res.writeHead(200, {
        "Content-Type":
          extension === "html"
            ? "text/html; charset=utf-8"
            : extension === "js"
              ? "text/javascript; charset=utf-8"
              : extension === "css"
                ? "text/css; charset=utf-8"
                : "image/svg+xml",
        "Cache-Control":
          extension === "html" ? "no-cache" : "public, max-age=3600",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  const configuredPort = Number(process.env.TRACKER_PORT ?? "4173");
  if (
    !Number.isInteger(configuredPort) ||
    configuredPort < 1024 ||
    configuredPort > 65535
  )
    throw new Error("TRACKER_PORT must be between 1024 and 65535.");
  async function listen(port: number): Promise<void> {
    await new Promise<void>((resolveListen, reject) => {
      const error = (e: Error) => reject(e);
      server.once("error", error);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", error);
        resolveListen();
      });
    });
  }
  try {
    await listen(configuredPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    await listen(0);
  }
  const port = (server.address() as { port: number }).port;
  console.log(
    `Roamio tracker · ${provider.health.mode.toUpperCase()}${provider.health.configured ? "" : " (key missing)"}\nLocal: http://127.0.0.1:${port}`,
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    service.close();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
