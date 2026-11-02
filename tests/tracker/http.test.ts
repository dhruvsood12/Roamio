import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createApi } from "../../apps/tracker-server/http";
import { createTrackerService } from "../../apps/tracker-server/service";
import { createDemoProvider } from "../../apps/tracker-server/demo";
import { createFlightAwareProvider } from "../../apps/tracker-server/flightaware";
import { NOW } from "./helpers";

function setup() {
  return createApi(
    createTrackerService(createDemoProvider(() => NOW)),
    () => 0,
  );
}
async function request(
  api: ReturnType<typeof createApi>,
  url: string,
  method = "GET",
) {
  let status = 0,
    text = "";
  const headers: Record<string, unknown> = {};
  const res = {
    writeHead(code: number, h: Record<string, unknown>) {
      status = code;
      Object.assign(headers, h);
    },
    setHeader(key: string, value: unknown) {
      headers[key] = value;
    },
    end(value: string) {
      text = value;
    },
  } as unknown as ServerResponse;
  await api(
    { url, method, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
    res,
  );
  return { status, body: JSON.parse(text), headers };
}
describe("tracker HTTP boundary", () => {
  it("returns normalized data and non-cacheable responses", async () => {
    const r = await request(setup(), "/api/flights/rm%20104?date=2026-11-01");
    expect(r.status).toBe(200);
    expect(r.body.query.flightNumber).toBe("RM104");
    expect(r.body.flights[0].data.mode).toBe("demo");
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });
  it("returns public demo health without environment data", async () => {
    const r = await request(setup(), "/api/health");
    expect(r.body.mode).toBe("demo");
    expect(r.body.examples).toHaveLength(11);
    expect(Object.keys(r.body).sort()).toEqual([
      "configured",
      "examples",
      "mode",
      "provider",
    ]);
  });
  it("exposes unconfigured live health honestly", async () => {
    const api = createApi(
      createTrackerService(createFlightAwareProvider(undefined)),
    );
    expect((await request(api, "/api/health")).body).toMatchObject({
      mode: "live",
      configured: false,
    });
  });
  it.each([
    "/api/flights/123?date=2026-11-01",
    "/api/flights/UA123?date=2026-02-30",
    "/api/flights/%?date=2026-11-01",
    "/api/flights/UA123?date=2026-11-01&date=2026-11-02",
    "/api/flights/UA123?url=https://secret",
    "/api/flights/UA123?date=11-1-2026",
  ])("rejects bad request %s", async (url) => {
    const r = await request(setup(), url);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_request");
  });
  it.each([
    "/api/fetch?url=https://example.com",
    "/api/flights/UA123/secret",
    "/api/unknown",
  ])("has no arbitrary proxy %s", async (url) =>
    expect((await request(setup(), url)).status).toBe(404),
  );
  it("rejects mutation methods", async () =>
    expect((await request(setup(), "/api/health", "POST")).status).toBe(405));
  it("returns a useful not-found response", async () => {
    const r = await request(setup(), "/api/flights/RM404?date=2026-11-01");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("flight_not_found");
  });
  it("maps failures without provider stack traces", async () => {
    const r = await request(setup(), "/api/flights/RM500?date=2026-11-01");
    expect(r.status).toBe(502);
    expect(Object.keys(r.body.error).sort()).toEqual([
      "code",
      "message",
      "retryAfterSeconds",
    ]);
  });
  it("exposes bounded Retry-After", async () => {
    const r = await request(setup(), "/api/flights/RM429?date=2026-11-01");
    expect(r.status).toBe(429);
    expect(r.headers["Retry-After"]).toBe(30);
  });
  it("limits accidental client request storms", async () => {
    const api = setup();
    for (let i = 0; i < 90; i++)
      expect((await request(api, "/api/health")).status).toBe(200);
    const r = await request(api, "/api/health");
    expect(r.status).toBe(429);
    expect(r.headers["Retry-After"]).toBe(60);
  });
});
