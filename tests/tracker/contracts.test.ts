import { describe, expect, it } from "vitest";
import {
  FlightNumber,
  QuerySchema,
  SnapshotSchema,
  Instant,
  dateAt,
  delayMinutes,
  freshness,
  isStale,
  timeLabel,
  safeTimezone,
  parseFlightPath,
  flightPath,
  progress,
  pollInterval,
} from "../../apps/tracker-shared/contracts";
import {
  createDemoProvider,
  DEMO_EXAMPLES,
} from "../../apps/tracker-server/demo";
import { NOW, QUERY, demoResult } from "./helpers";

describe("tracker domain boundary", () => {
  it.each([
    "UA123",
    "ua 123",
    " UAL 123 ",
    "9W123",
    "B61234",
    "BA123A",
    "A123",
  ])("normalizes flight number %s", (input) =>
    expect(FlightNumber.parse(input)).toBe(
      input.trim().toUpperCase().replace(/\s/g, ""),
    ),
  );
  it.each([
    "",
    "12345",
    "A1",
    "AB12345",
    "ABCD123",
    "../UA123",
    "UA123?x=1",
    "<script>",
    "https://foo",
    "x".repeat(100),
  ])("rejects malformed identifier %s", (v) =>
    expect(FlightNumber.safeParse(v).success).toBe(false),
  );
  it.each([
    "2026-02-29",
    "0000-01-01",
    "1899-12-31",
    "2101-01-01",
    "9999-12-31",
    "11/01/2026",
    "2026-11-31",
    "2026-1-1",
    "2026-11-01T00:00:00Z",
  ])("rejects non-calendar date %s", (date) =>
    expect(QuerySchema.safeParse({ ...QUERY, date }).success).toBe(false),
  );
  it.each([
    "2026-11-01T10:00:00Z",
    "2026-11-01T12:00:00+02:00",
    "2026-11-01T10:00:00.123Z",
  ])("accepts explicit instant %s", (value) =>
    expect(Instant.parse(value)).toBe(value),
  );
  it.each([
    "2026-11-01T10:00:00",
    "2026-11-01T10:00Z",
    "2026-11-01T10:00:00-00:00",
    "2026-11-01T10:00:00.1234Z",
    "not a date",
  ])("rejects ambiguous/lossy instant %s", (value) =>
    expect(Instant.safeParse(value).success).toBe(false),
  );
  it("roundtrips strict JSON without provider metadata", async () => {
    const f = (await demoResult()).flights[0];
    expect(SnapshotSchema.parse(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(
      SnapshotSchema.safeParse({ ...f, providerMetadata: { secret: true } })
        .success,
    ).toBe(false);
  });
  it("rejects request completion before start but accepts equivalent offset", async () => {
    const f = (await demoResult()).flights[0];
    f.data.retrievedAt = "2026-11-01T18:00:00.122Z";
    expect(SnapshotSchema.safeParse(f).success).toBe(false);
    f.data.retrievedAt = "2026-11-01T20:00:00.123+02:00";
    expect(SnapshotSchema.safeParse(f).success).toBe(true);
  });
  it("rejects a demo pretending to be live", async () => {
    const f = (await demoResult()).flights[0];
    f.data.mode = "live";
    expect(SnapshotSchema.safeParse(f).success).toBe(false);
  });
  it.each(["scheduled", "estimated", "actual"] as const)(
    "rejects reversed %s events",
    async (kind) => {
      const f = (await demoResult()).flights[0];
      f[kind] = {
        departure: "2026-11-01T10:00:00.001Z",
        arrival: "2026-11-01T10:00:00Z",
      };
      expect(SnapshotSchema.safeParse(f).success).toBe(false);
    },
  );
  it("rejects reversed partial actual runway events", async () => {
    const f = (await demoResult()).flights[0];
    f.runway.landingAt = "2026-11-01T01:00:00Z";
    expect(SnapshotSchema.safeParse(f).success).toBe(false);
  });
  it("allows missing estimates and explicit optional nulls", async () => {
    const f = (await demoResult()).flights[0];
    f.estimated = { departure: null, arrival: null };
    f.position = null;
    f.aircraft = { registration: null, type: null, model: null };
    expect(SnapshotSchema.parse(f)).toEqual(f);
  });
  it.each([
    [-91, 0],
    [91, 0],
    [0, 181],
    [0, -181],
  ])("rejects invalid coordinates %s %s", async (latitude, longitude) => {
    const f = (await demoResult()).flights[0];
    f.position!.latitude = latitude;
    f.position!.longitude = longitude;
    expect(SnapshotSchema.safeParse(f).success).toBe(false);
  });
  it.each([
    [null, "2026-11-01T00:00:00Z", null],
    ["2026-11-01T00:00:00Z", null, null],
    ["2026-11-01T00:00:00Z", "2026-11-01T01:00:00+01:00", 0],
    ["2026-11-01T00:00:00.001Z", "2026-11-01T00:01:00Z", 0],
    ["2026-11-01T00:01:00Z", "2026-11-01T00:00:00Z", -1],
  ] as const)("delay arithmetic uses instants %s %s", (a, b, expected) =>
    expect(delayMinutes(a, b)).toBe(expected),
  );
  it("displays DST fall-back instants distinctly with timezone", () => {
    expect(timeLabel("2026-11-01T08:30:00Z", "America/Los_Angeles")).toContain(
      "PDT",
    );
    expect(timeLabel("2026-11-01T09:30:00Z", "America/Los_Angeles")).toContain(
      "PST",
    );
  });
  it("converts dates at origin timezone and labels unknown zones UTC", () => {
    expect(dateAt("2026-11-02T01:00:00Z", "America/Los_Angeles")).toBe(
      "2026-11-01",
    );
    expect(timeLabel("2026-11-01T12:00:00Z", "nonsense")).toContain("UTC");
    expect(safeTimezone("nonsense")).toBeNull();
    expect(timeLabel(null, null)).toBe("—");
  });
  it("does not confuse fresh retrieval with fresh source facts", async () => {
    const f = (await demoResult()).flights[0];
    f.data.mode = "live";
    f.data.provider = "flightaware";
    f.data.providerUpdatedAt = null;
    expect(freshness(f, NOW)).toBe("RECENT");
    f.data.providerUpdatedAt = new Date(NOW - 600_000).toISOString();
    expect(freshness(f, NOW)).toBe("STALE");
    f.data.providerUpdatedAt = new Date(NOW - 5000).toISOString();
    expect(freshness(f, NOW)).toBe("LIVE");
  });
  it("treats local clock rollback/future source as unconfirmed freshness", async () => {
    const f = (await demoResult()).flights[0];
    expect(isStale(f, NOW - 120_000)).toBe(true);
  });
  it("never relabels demo data LIVE, even when recent", async () => {
    const f = (await demoResult()).flights[0];
    expect(freshness(f, NOW)).toBe("DEMO");
    expect(freshness(f, NOW + 600_000)).toBe("DEMO");
    expect(isStale(f, NOW + 600_000)).toBe(true);
  });
  it("supports deep links and rejects malformed escapes/paths", () => {
    expect(parseFlightPath(flightPath(QUERY))).toEqual(QUERY);
    for (const path of [
      "/flight/%/2026-11-01",
      "/flight/UA123/2026-02-30",
      "/flight/UA123/2026-11-01/extra",
      "/api/fetch",
    ])
      expect(parseFlightPath(path)).toBeNull();
  });
  it("time-based progress is bounded, labelled and needs both instants", async () => {
    const f = (await demoResult()).flights[0];
    expect(progress(f, NOW).fraction).toBeGreaterThan(0);
    expect(progress(f, NOW).label).toContain("not aircraft location");
    expect(progress(f, NOW + 86_400_000).fraction).toBe(1);
    f.estimated.arrival = null;
    expect(progress(f, NOW).fraction).toBe(0);
  });
  it("does not manufacture progress for cancellation", async () => {
    const f = (await demoResult({ ...QUERY, flightNumber: "RM106" }))
      .flights[0];
    expect(progress(f, NOW)).toEqual({
      fraction: 0,
      label: "Flight cancelled",
    });
  });
  it("polls active flights faster and finished ones slower", async () => {
    const f = (await demoResult()).flights[0];
    expect(pollInterval(f)).toBe(15000);
    f.data.mode = "live";
    expect(pollInterval(f)).toBe(30000);
    f.status = "arrived";
    expect(pollInterval(f)).toBe(300000);
    f.status = "scheduled";
    expect(pollInterval(f)).toBe(120000);
  });
});
describe("synthetic demo provider", () => {
  it.each(["2026-03-08", "2026-11-01", "2026-11-02"])(
    "keeps every scenario on its origin-local operating date %s",
    async (date) => {
      for (const example of DEMO_EXAMPLES) {
        const f = (
          await demoResult({ flightNumber: example.flightNumber, date })
        ).flights[0];
        expect(dateAt(f.scheduled.departure!, f.origin.timezone)).toBe(date);
      }
    },
  );
  it.each(DEMO_EXAMPLES)("validates $flightNumber ($label)", async (e) => {
    const result = await demoResult({ ...QUERY, flightNumber: e.flightNumber });
    expect(SnapshotSchema.parse(result.flights[0]).data.mode).toBe("demo");
  });
  it("is deterministic for the same clock and query", async () =>
    expect(await demoResult()).toEqual(await demoResult()));
  it("leaves missing gate and position genuinely unknown", async () => {
    expect(
      (await demoResult({ ...QUERY, flightNumber: "RM108" })).flights[0].origin
        .gate,
    ).toBeNull();
    expect(
      (await demoResult({ ...QUERY, flightNumber: "RM109" })).flights[0]
        .position,
    ).toBeNull();
  });
  it("preserves stale source time despite fresh receipt", async () => {
    const f = (await demoResult({ ...QUERY, flightNumber: "RM110" }))
      .flights[0];
    expect(f.data.retrievedAt).toBe(new Date(NOW).toISOString());
    expect(isStale(f, NOW)).toBe(true);
  });
  it.each([
    ["RM500", "provider_unavailable"],
    ["RM429", "rate_limited"],
    ["UA123", "flight_not_found"],
  ])("exposes typed failure %s", async (flightNumber, code) =>
    expect(demoResult({ ...QUERY, flightNumber })).rejects.toMatchObject({
      code,
    }),
  );
  it("clamps local completion on clock rollback", async () => {
    const times = [NOW, NOW + 1000, NOW - 1000];
    const p = createDemoProvider(() => times.shift() ?? NOW);
    const f = (await p.search(QUERY, new AbortController().signal)).flights[0];
    expect(f.data.retrievedAt).toBe(f.data.requestStartedAt);
  });
  it("honors an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createDemoProvider().search(QUERY, controller.signal),
    ).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
});
