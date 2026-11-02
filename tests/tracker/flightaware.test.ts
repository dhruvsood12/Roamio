import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/aeroapi.json";
import {
  AeroFlightSchema,
  createFlightAwareProvider,
  dateWindow,
  mapFlight,
  normalizeStatus,
} from "../../apps/tracker-server/flightaware";
import { NOW, QUERY, response } from "./helpers";

function setup(
  payload: unknown = fixture,
  extras: { position?: unknown; airportStatus?: number } = {},
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/airports/"))
        return response(
          String(url).endsWith("KSFO")
            ? { latitude: 37.619, longitude: -122.375 }
            : { latitude: 40.641, longitude: -73.778 },
          extras.airportStatus ?? 200,
        );
      if (String(url).endsWith("/position"))
        return response(
          extras.position ?? {
            last_position: {
              latitude: 41.3,
              longitude: -102.2,
              altitude: 350,
              groundspeed: 462,
              heading: 82,
              timestamp: "2026-11-01T17:59:30Z",
            },
          },
        );
      return response(payload);
    },
  );
  return {
    calls,
    transport,
    provider: createFlightAwareProvider("synthetic-test-key", {
      fetch: transport,
      clock: () => NOW,
    }),
  };
}
const signal = () => new AbortController().signal;
describe("official-schema FlightAware adapter (synthetic responses)", () => {
  it("does not spend map calls for a scheduled flight", async () => {
    const raw = structuredClone(fixture);
    Object.assign(raw.flights[0], {
      actual_out: null,
      actual_off: null,
      estimated_out: null,
      status: "Scheduled",
    });
    const { provider, calls } = setup(raw);
    await provider.search(QUERY, signal());
    expect(calls).toHaveLength(1);
  });
  it("skips airport-detail calls when no position is available", async () => {
    const { provider, calls } = setup(fixture, {
      position: { last_position: null },
    });
    await provider.search(QUERY, signal());
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("/airports/"))).toBe(false);
  });
  it("maps flight facts, gate/runway distinctions, aircraft and position units", async () => {
    const { provider } = setup();
    const f = (await provider.search(QUERY, signal())).flights[0];
    expect(f.status).toBe("in_air");
    expect(f.actual.departure).toBe("2026-11-01T16:18:00.123Z");
    expect(f.runway.takeoffAt).toBe("2026-11-01T16:30:00.123Z");
    expect(f.position?.altitudeFeet).toBe(35000);
    expect(f.position?.groundspeedKnots).toBe(462);
    expect(f.origin.coordinates?.longitude).toBe(-122.375);
    expect(f.origin.gate).toBe("F12");
    expect(f.aircraft.type).toBe("A321");
    expect(f.delayMinutes.departure).toBe(18);
    expect(f.data.providerUpdatedAt).toBeNull();
  });
  it("sends credentials only to the fixed official host, with bounded pagination", async () => {
    const { provider, calls } = setup();
    await provider.search(QUERY, signal());
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.url.startsWith("https://aeroapi.flightaware.com/aeroapi/")).toBe(
        true,
      );
      expect(c.init?.redirect).toBe("error");
      expect(c.init?.headers).toMatchObject({
        "x-apikey": "synthetic-test-key",
      });
    }
    expect(calls[0].url).toContain("ident_type=designator");
    expect(calls[0].url).toContain("max_pages=1");
  });
  it("strips arbitrary raw fields and never exposes the provider key or ID", async () => {
    const raw = structuredClone(fixture);
    Object.assign(raw.flights[0], {
      raw_key: "secret-marker",
      private_notes: { ssn: "private-marker" },
    });
    const { provider } = setup(raw);
    const output = JSON.stringify(await provider.search(QUERY, signal()));
    for (const needle of [
      "secret-marker",
      "private-marker",
      "synthetic-test-key",
      "fa_flight_id",
      "synthetic-roamio-104",
    ])
      expect(output).not.toContain(needle);
  });
  it("maps missing optional facts to explicit nulls", async () => {
    const raw = structuredClone(fixture);
    const f = raw.flights[0] as Record<string, unknown>;
    for (const key of [
      "gate_origin",
      "registration",
      "aircraft_type",
      "estimated_in",
      "estimated_out",
      "actual_out",
      "actual_off",
      "operator",
      "operator_iata",
      "operator_icao",
      "flight_number",
    ])
      delete f[key];
    f.status = "Scheduled";
    const out = (await setup(raw).provider.search(QUERY, signal())).flights[0];
    expect(out.origin.gate).toBeNull();
    expect(out.position).toBeNull();
    expect(out.estimated.arrival).toBeNull();
    expect(out.aircraft.model).toBeNull();
    expect(out.flight.operatingCarrier).toBeNull();
  });
  it.each([
    [{ status: "Cancelled", cancelled: true }, "cancelled"],
    [{ cancelled: true, actual_off: null, actual_out: null }, "unknown"],
    [{ diverted: true }, "diverted"],
    [
      { actual_in: "2026-11-01T21:45:00Z", actual_on: "2026-11-01T21:40:00Z" },
      "arrived",
    ],
    [{ actual_on: "2026-11-01T21:40:00Z" }, "landed"],
    [{ actual_off: null }, "departed"],
    [{ actual_off: null, actual_out: null, status: "Boarding" }, "boarding"],
    [
      {
        actual_off: null,
        actual_out: null,
        status: "Scheduled",
        estimated_out: "2026-11-01T16:45:00Z",
      },
      "delayed",
    ],
    [
      {
        actual_off: null,
        actual_out: null,
        status: "Scheduled / On Time",
        estimated_out: null,
      },
      "scheduled",
    ],
    [
      {
        actual_off: null,
        actual_out: null,
        status: "Unexpected provider status",
        estimated_out: null,
      },
      "unknown",
    ],
  ])("normalizes status conservatively %j → %s", (patch, expected) =>
    expect(
      normalizeStatus(
        AeroFlightSchema.parse({ ...fixture.flights[0], ...patch }),
      ),
    ).toBe(expected),
  );
  it("does not replace gate arrival with touchdown", () => {
    const f = mapFlight(
      AeroFlightSchema.parse({
        ...fixture.flights[0],
        actual_on: "2026-11-01T21:40:00Z",
      }),
      QUERY,
      NOW,
      NOW,
    );
    expect(f.actual.arrival).toBeNull();
    expect(f.status).toBe("landed");
  });
  it("matches documented codeshare identifiers without inventing operating identity", async () => {
    const f = (
      await setup().provider.search(
        { ...QUERY, flightNumber: "SY204" },
        signal(),
      )
    ).flights[0];
    expect(f.flight.requestedIdent).toBe("SY204");
    expect(f.flight.ident).toBe("RM104");
  });
  it("filters unrelated and public-blocked flight records", async () => {
    const raw = structuredClone(fixture);
    raw.flights[0].blocked = true;
    await expect(
      setup(raw).provider.search(QUERY, signal()),
    ).rejects.toMatchObject({ code: "flight_not_found" });
    await expect(
      setup().provider.search({ ...QUERY, flightNumber: "XX999" }, signal()),
    ).rejects.toMatchObject({ code: "flight_not_found" });
  });
  it("preserves separate matches and duplicated diversion provider IDs", async () => {
    const raw = structuredClone(fixture);
    raw.flights.push({ ...raw.flights[0], diverted: true });
    const result = await setup(raw).provider.search(QUERY, signal());
    expect(result.flights).toHaveLength(2);
    expect(new Set(result.flights.map((f) => f.id)).size).toBe(2);
  });
  it("filters by origin-local date across UTC midnight", async () => {
    const raw = structuredClone(fixture);
    Object.assign(raw.flights[0], {
      scheduled_out: "2026-11-02T01:00:00Z",
      scheduled_in: "2026-11-02T06:30:00Z",
    });
    const result = await setup(raw).provider.search(QUERY, signal());
    expect(result.flights).toHaveLength(1);
    expect(result.flights[0].dateBasis).toBe("origin_local");
  });
  it("uses explicitly labelled UTC date fallback for unknown timezone", async () => {
    const raw = structuredClone(fixture);
    raw.flights[0].origin.timezone = "invalid/zone";
    const result = await setup(raw).provider.search(QUERY, signal());
    expect(result.flights[0].dateBasis).toBe("utc_fallback");
    expect(result.flights[0].data.notices).toContain("timezone_unknown");
  });
  it("does not infer an operating date when no schedule is supplied", async () => {
    const raw = structuredClone(fixture);
    Object.assign(raw.flights[0], { scheduled_out: null, scheduled_off: null });
    await expect(
      setup(raw).provider.search(QUERY, signal()),
    ).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
  it("does not follow arbitrary provider pagination URLs", async () => {
    const raw = {
      ...structuredClone(fixture),
      links: { next: "https://attacker.invalid/secret" },
    };
    const { provider, calls } = setup(raw);
    expect((await provider.search(QUERY, signal())).coverage).toBe("limited");
    expect(calls.every((c) => !c.url.includes("attacker"))).toBe(true);
  });
  it("does not claim definitive not-found for truncated enumeration", async () => {
    await expect(
      setup({
        flights: [],
        links: { next: "cursor" },
        num_pages: 1,
      }).provider.search(QUERY, signal()),
    ).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
  it("allows no position and degrades invalid optional enrichment", async () => {
    for (const position of [
      { last_position: null },
      { last_position: { latitude: 999 } },
    ]) {
      const f = (
        await setup(fixture, { position, airportStatus: 403 }).provider.search(
          QUERY,
          signal(),
        )
      ).flights[0];
      expect(f.status).toBe("in_air");
      expect(f.position).toBeNull();
      expect(f.origin.coordinates).toBeNull();
    }
  });
  it.each([
    {},
    { flights: "wrong" },
    {
      ...fixture,
      flights: [{ ...fixture.flights[0], scheduled_out: "yesterday" }],
    },
    { ...fixture, flights: [{ ...fixture.flights[0], actual_off: 123 }] },
  ])("rejects malformed provider data %j", async (payload) =>
    expect(
      setup(payload).provider.search(QUERY, signal()),
    ).rejects.toMatchObject({ code: "provider_unavailable" }),
  );
  it.each([
    [401, "provider_unavailable"],
    [403, "provider_unavailable"],
    [404, "flight_not_found"],
    [500, "provider_unavailable"],
    [429, "rate_limited"],
  ])("maps HTTP %i safely", async (status, code) => {
    const provider = createFlightAwareProvider("key", {
      fetch: async () =>
        response({ detail: "sensitive-provider-detail" }, Number(status)),
      clock: () => NOW,
    });
    await expect(provider.search(QUERY, signal())).rejects.toMatchObject({
      code,
    });
  });
  it("uses bounded Retry-After cooldown across different queries", async () => {
    let mono = 0;
    const fetch = vi.fn(async () =>
      response({}, 429, { "retry-after": "99999" }),
    );
    const provider = createFlightAwareProvider("key", {
      fetch,
      clock: () => NOW,
      monotonic: () => mono,
    });
    await expect(provider.search(QUERY, signal())).rejects.toMatchObject({
      retryAfterSeconds: 3600,
    });
    await expect(
      provider.search({ ...QUERY, flightNumber: "RM101" }, signal()),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetch).toHaveBeenCalledTimes(1);
    mono += 3600_000;
    await expect(provider.search(QUERY, signal())).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("handles transport failure and invalid JSON without raw exceptions", async () => {
    for (const fetch of [
      async () => {
        throw new Error("private-secret");
      },
      async () => new Response("not json"),
    ]) {
      await expect(
        createFlightAwareProvider("key", { fetch, clock: () => NOW }).search(
          QUERY,
          signal(),
        ),
      ).rejects.toMatchObject({
        code: "provider_unavailable",
        message: expect.not.stringContaining("private-secret"),
      });
    }
  });
  it("fails live mode without a key instead of silently using demo", async () => {
    const fetch = vi.fn();
    const provider = createFlightAwareProvider(undefined, {
      fetch,
      clock: () => NOW,
    });
    expect(provider.health).toMatchObject({ mode: "live", configured: false });
    await expect(provider.search(QUERY, signal())).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("limits response bytes", async () => {
    const fetch = async () => new Response(" ".repeat(2_000_001));
    await expect(
      createFlightAwareProvider("key", { fetch, clock: () => NOW }).search(
        QUERY,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it("clamps local receipt under clock rollback", async () => {
    const raw = AeroFlightSchema.parse(fixture.flights[0]);
    const f = mapFlight(raw, QUERY, NOW, NOW - 60000);
    expect(f.data.retrievedAt).toBe(f.data.requestStartedAt);
  });
  it("bounds the documented query window without claiming full coverage", () => {
    const w = dateWindow("2026-11-03", NOW);
    expect(w.end).toBe(NOW + 2 * 86_400_000);
    expect(w.limited).toBe(true);
    expect(() => dateWindow("2027-01-01", NOW)).toThrow();
    expect(() => dateWindow("2026-01-01", NOW)).toThrow();
  });
  it("caches optional airport detail calls", async () => {
    const { provider, calls } = setup();
    await provider.search(QUERY, signal());
    await provider.search(QUERY, signal());
    expect(calls.filter((c) => c.url.includes("/airports/")).length).toBe(2);
  });
});
