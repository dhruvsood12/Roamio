import type { IncomingMessage, ServerResponse } from "node:http";
import { QuerySchema } from "../tracker-shared/contracts";
import { TrackerError, publicError, errorStatus } from "./provider";
import type { TrackerService } from "./service";

export function createApi(
  service: TrackerService,
  monotonic = () => performance.now(),
) {
  const clients = new Map<string, { reset: number; count: number }>();
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        send(405, {
          error: {
            code: "invalid_request",
            message: "Use GET for flight lookups.",
            retryAfterSeconds: null,
          },
        });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const client = req.socket.remoteAddress ?? "local",
        now = monotonic();
      let bucket = clients.get(client);
      if (!bucket || bucket.reset <= now) {
        if (clients.size >= 1024) clients.delete(clients.keys().next().value!);
        bucket = { reset: now + 60_000, count: 0 };
        clients.set(client, bucket);
      }
      if (++bucket.count > 90)
        throw new TrackerError(
          "rate_limited",
          Math.max(1, Math.ceil((bucket.reset - now) / 1000)),
        );
      if (url.pathname === "/api/health") {
        send(200, service.health);
        return;
      }
      const match = /^\/api\/flights\/([^/]+)$/.exec(url.pathname);
      if (!match) {
        send(404, {
          error: {
            code: "invalid_request",
            message: "This endpoint does not exist.",
            retryAfterSeconds: null,
          },
        });
        return;
      }
      if (
        [...url.searchParams.keys()].some((k) => k !== "date") ||
        url.searchParams.getAll("date").length > 1
      )
        throw new TrackerError("invalid_request");
      let flightNumber: string;
      try {
        flightNumber = decodeURIComponent(match[1]);
      } catch {
        throw new TrackerError("invalid_request");
      }
      const query = QuerySchema.safeParse({
        flightNumber,
        date:
          url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10),
      });
      if (!query.success) throw new TrackerError("invalid_request");
      send(200, await service.search(query.data));
    } catch (error) {
      const safe = publicError(error);
      if (safe.retryAfterSeconds)
        res.setHeader("Retry-After", safe.retryAfterSeconds);
      send(errorStatus[safe.code], {
        error: {
          code: safe.code,
          message: safe.message,
          retryAfterSeconds: safe.retryAfterSeconds,
        },
      });
    }
  };
}
