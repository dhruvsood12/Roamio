import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BookingComponentSchema, FlightOfferSchema, PaymentQuoteSchema, RouteDiscoveryResultSchema, TripOptionSchema,
  type BookingComponent, type FlightOffer, type PaymentQuote, type RouteDiscoveryResult, type TripOption,
} from "@flightbrain/domain";
import {
  createRome2RioSourceDefinition, Rome2RioClientError, Rome2RioDiscoverySource, validateRouteDiscoveryResult,
  type Rome2RioClient, type Rome2RioFailureCode, type RouteDiscoveryContext,
} from "@flightbrain/discovery";
import { discoveryRequest } from "./fixtures/discovery";

// Synthetic permission enables MOCK CLIENTS only. This is not a Rome2Rio policy
// review, tool schema, captured response, or grant of any real-source usage right.
function mockPermission() {
  const source = createRome2RioSourceDefinition();
  source.persistencePolicy.transientUse = {
    status: "allowed", reviewedAt: "2026-10-06T00:00:00Z", reference: "synthetic-mock-client-only",
  };
  return source;
}
const context = (signal = new AbortController().signal, deadlineAt: string | null = null): RouteDiscoveryContext => ({ signal, deadlineAt });
function freezeDeep(value: unknown): void {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
}
afterEach(() => vi.useRealTimers());

describe("Rome2Rio schema-independent failure scaffold", () => {
  it("denies source calls by default while actual transient-use rights are unknown", async () => {
    const client: Rome2RioClient = { getRoutes: vi.fn() };
    const source = new Rome2RioDiscoverySource(client);
    expect(source.mappingStatus).toBe("blocked_schema_discovery");
    expect(await source.discover(discoveryRequest(), context())).toMatchObject({
      sourceId: "rome2rio", status: "error", diagnostics: ["access_denied"], candidates: [],
    });
    expect(client.getRoutes).not.toHaveBeenCalled();
  });

  it.each(["unknown", "restricted", "disabled"] as const)("does not invoke a %s source even with synthetic transient-use permission", async status => {
    const definition = mockPermission(); definition.productionUse.status = status;
    const client: Rome2RioClient = { getRoutes: vi.fn() };
    expect((await new Rome2RioDiscoverySource(client, definition).discover(discoveryRequest(), context())).diagnostics).toEqual(["access_denied"]);
    expect(client.getRoutes).not.toHaveBeenCalled();
  });

  it("does not let production approval imply transient-use permission", async () => {
    const definition = createRome2RioSourceDefinition();
    definition.productionUse = { status: "approved", reviewedAt: "2026-10-06T00:00:00Z", reference: "synthetic-test-only" };
    const client: Rome2RioClient = { getRoutes: vi.fn() };
    expect((await new Rome2RioDiscoverySource(client, definition).discover(discoveryRequest(), context())).diagnostics).toEqual(["access_denied"]);
    expect(client.getRoutes).not.toHaveBeenCalled();
  });

  it.each(["access_denied", "quota_limited", "source_unavailable", "timeout", "cancelled"] as const)("maps a typed %s failure to fixed canonical diagnostics", async code => {
    const request = discoveryRequest(), definition = mockPermission();
    const source = new Rome2RioDiscoverySource({ getRoutes: async () => { throw new Rome2RioClientError(code); } }, definition);
    const result = await source.discover(request, context());
    expect(result).toMatchObject({
      sourceId: "rome2rio", requestId: request.requestId, candidates: [],
      status: code === "timeout" ? "timeout" : "error", diagnostics: [code === "timeout" ? "deadline_exceeded" : code],
    });
    expect(validateRouteDiscoveryResult(result, definition, request)).toEqual(result);
    expect(RouteDiscoveryResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it.each([
    new Error("Bearer SYNTHETIC"), { accessToken: "SYNTHETIC-SECRET", rawResponse: { session: "SYNTHETIC" } },
    "access_token=SYNTHETIC", "session=SYNTHETIC",
  ])("does not serialize or infer error codes from an untrusted exception %#", async failure => {
    const source = new Rome2RioDiscoverySource({ getRoutes: async () => { throw failure; } }, mockPermission());
    const result = await source.discover(discoveryRequest(), context());
    expect(result).toMatchObject({ status: "error", diagnostics: ["internal_error"], candidates: [] });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });

  it("handles a synchronous client exception without leaking it", async () => {
    const source = new Rome2RioDiscoverySource({ getRoutes: () => { throw new Error("SYNTHETIC-SECRET"); } }, mockPermission());
    expect((await source.discover(discoveryRequest(), context())).diagnostics).toEqual(["internal_error"]);
  });

  it("does not serialize a forged typed failure code", async () => {
    const source = new Rome2RioDiscoverySource({ getRoutes: async () => {
      throw new Rome2RioClientError("Bearer SYNTHETIC" as Rome2RioFailureCode);
    } }, mockPermission());
    const result = await source.discover(discoveryRequest(), context());
    expect(result.diagnostics).toEqual(["internal_error"]);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });

  it.each([null, [], {}, { routes: [] }, { candidates: [] }])("never assumes an unknown fulfilled payload is empty success %#", async payload => {
    // Deliberately arbitrary malformed/unknown values, NOT purported native fixtures.
    const source = new Rome2RioDiscoverySource({ getRoutes: async () => payload }, mockPermission());
    expect(await source.discover(discoveryRequest(), context())).toMatchObject({
      status: "error", candidates: [], diagnostics: ["source_unavailable"],
    });
  });

  it("keeps private request endpoints and raw client payloads out of failure JSON", async () => {
    const request = discoveryRequest();
    request.origin = { kind: "address", address: "SYNTHETIC-PRIVATE-HOME-123", countryCode: "SE" };
    request.destination = { kind: "point", coordinates: { latitude: 59.1234567, longitude: 18.7654321 } };
    const raw = { origin: request.origin, destination: request.destination, authorization: "Bearer SYNTHETIC",
      externalRouteId: "https://example.test/private?access_token=SYNTHETIC&session=SYNTHETIC", rawResponse: "SYNTHETIC-SECRET" };
    const source = new Rome2RioDiscoverySource({ getRoutes: async () => raw }, mockPermission());
    const result = await source.discover(request, context());
    for (const marker of ["SYNTHETIC", "59.1234567", "18.7654321", "authorization", "rawResponse", "externalRouteId"]) {
      expect(JSON.stringify(result)).not.toContain(marker);
    }
    expect(result.candidates).toEqual([]);
    // This proves failure-output isolation, not privacy handling in a native mapper.
  });

  it("never inspects or serializes a fulfilled opaque payload", async () => {
    const payload = { get routes() { throw new Error("must not guess native fields"); }, toJSON() { throw new Error("must not serialize raw payload"); } };
    const source = new Rome2RioDiscoverySource({ getRoutes: async () => payload }, mockPermission());
    expect((await source.discover(discoveryRequest(), context())).diagnostics).toEqual(["source_unavailable"]);
  });

  it("isolates frozen request and definition inputs from client and caller mutations", async () => {
    const request = discoveryRequest(), definition = mockPermission();
    const before = structuredClone({ request, definition }); freezeDeep(request); freezeDeep(definition);
    const source = new Rome2RioDiscoverySource({ getRoutes: async input => {
      input.requestId = "SYNTHETIC-SECRET"; input.origin = { kind: "point", coordinates: { latitude: 0, longitude: 0 } };
      return input;
    } }, definition);
    source.capabilities.schedules = true;
    const result = await source.discover(request, context());
    expect(result.requestId).toBe(request.requestId);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
    expect(source.capabilities).toEqual(definition.capabilities);
    expect({ request, definition }).toEqual(before);
  });

  it("copies rights configuration so later caller mutation cannot enable calls", async () => {
    const definition = createRome2RioSourceDefinition();
    const client: Rome2RioClient = { getRoutes: vi.fn() };
    const source = new Rome2RioDiscoverySource(client, definition);
    definition.persistencePolicy.transientUse = mockPermission().persistencePolicy.transientUse;
    expect((await source.discover(discoveryRequest(), context())).diagnostics).toEqual(["access_denied"]);
    expect(client.getRoutes).not.toHaveBeenCalled();
  });

  it.each([{ id: "another-source" }, { accessMethod: "api" }])("rejects mismatched source configuration %j", change => {
    expect(() => new Rome2RioDiscoverySource({ getRoutes: vi.fn() }, { ...mockPermission(), ...change } as ReturnType<typeof mockPermission>)).toThrow();
  });

  it("keeps discovery results outside commercial types at compile time and runtime", async () => {
    const result: RouteDiscoveryResult = await new Rome2RioDiscoverySource({ getRoutes: vi.fn() }).discover(discoveryRequest(), context());
    for (const schema of [FlightOfferSchema, PaymentQuoteSchema, BookingComponentSchema, TripOptionSchema]) expect(schema.safeParse(result).success).toBe(false);
    // @ts-expect-error A discovery result is not a commercial offer.
    const offer: FlightOffer = result;
    // @ts-expect-error A discovery result is not an authoritative payment quote.
    const payment: PaymentQuote = result;
    // @ts-expect-error A discovery result is not a booking component.
    const booking: BookingComponent = result;
    // @ts-expect-error A discovery result is not a complete trip.
    const trip: TripOption = result;
    void [offer, payment, booking, trip];
  });
});

describe("Rome2Rio request cancellation and deadlines", () => {
  it("does not call a client for an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort("SYNTHETIC-SECRET");
    const client: Rome2RioClient = { getRoutes: vi.fn() };
    const result = await new Rome2RioDiscoverySource(client, mockPermission()).discover(discoveryRequest(), context(controller.signal));
    expect(result).toMatchObject({ status: "error", diagnostics: ["cancelled"], candidates: [] });
    expect(client.getRoutes).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });

  it.each(["2026-10-06T00:00:00Z", "2026-10-06T02:00:00+02:00", "2026-10-05T23:59:59.999Z"])("recognizes expired or equal deadline %s without a call", async deadline => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-06T00:00:00Z");
    const client: Rome2RioClient = { getRoutes: vi.fn() };
    const result = await new Rome2RioDiscoverySource(client, mockPermission()).discover(discoveryRequest(), context(undefined, deadline));
    expect(result).toMatchObject({ status: "timeout", diagnostics: ["deadline_exceeded"] });
    expect(client.getRoutes).not.toHaveBeenCalled();
  });

  it.each(["invalid", "2026-10-06T00:00:00-00:00", "2026-11-30T00:00:00Z"])("rejects an invalid or unrepresentable timer deadline %s", async deadline => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-06T00:00:00Z");
    const client: Rome2RioClient = { getRoutes: vi.fn() };
    expect((await new Rome2RioDiscoverySource(client, mockPermission()).discover(discoveryRequest(), context(undefined, deadline))).diagnostics).toEqual(["unsupported_request"]);
    expect(client.getRoutes).not.toHaveBeenCalled();
  });

  it("stops waiting at the deadline even if a client ignores its abort signal", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-06T00:00:00Z");
    let clientSignal: AbortSignal | undefined;
    let rejectLater: (error: Error) => void = () => {};
    const client: Rome2RioClient = { getRoutes: vi.fn((_request, ctx) => {
      clientSignal = ctx.signal; return new Promise((_, reject) => { rejectLater = reject; });
    }) };
    const pending = new Rome2RioDiscoverySource(client, mockPermission()).discover(discoveryRequest(), context(undefined, "2026-10-06T02:00:00.010+02:00"));
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ status: "timeout", diagnostics: ["deadline_exceeded"], candidates: [] });
    expect(clientSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    rejectLater(new Error("SYNTHETIC-SECRET"));
    await vi.advanceTimersByTimeAsync(0); // Late rejection remains handled.
  });

  it("propagates cancellation and releases its timer/listener even when a client never settles", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-06T00:00:00Z");
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let clientSignal: AbortSignal | undefined;
    const source = new Rome2RioDiscoverySource({ getRoutes: async (_request, ctx) => {
      clientSignal = ctx.signal; return new Promise(() => {});
    } }, mockPermission());
    const pending = source.discover(discoveryRequest(), context(controller.signal, "2026-10-06T00:01:00Z"));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort("Bearer SYNTHETIC");
    expect(await pending).toMatchObject({ status: "error", diagnostics: ["cancelled"] });
    expect(clientSignal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up cancellation resources when the client finishes first", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-06T00:00:00Z");
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, "removeEventListener");
    const source = new Rome2RioDiscoverySource({ getRoutes: async () => null }, mockPermission());
    await source.discover(discoveryRequest(), context(controller.signal, "2026-10-06T00:01:00Z"));
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("Rome2Rio local adapter-attempt timestamps", () => {
  const startedAt = "2026-10-06T12:00:00.000Z";
  const rolledBackAt = "2026-10-06T11:59:59.000Z";
  afterEach(() => vi.restoreAllMocks());

  function expectCanonical(result: RouteDiscoveryResult, definition = mockPermission()) {
    expect(validateRouteDiscoveryResult(result, definition, discoveryRequest())).toEqual(result);
    expect(RouteDiscoveryResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
    expect(result.candidates).toEqual([]);
  }

  it.each(["opaque", "source_unavailable", "access_denied", "quota_limited", "timeout", "cancelled", "unexpected"] as const)(
    "preserves the %s outcome when the client completes after clock rollback", async outcome => {
      vi.useFakeTimers(); vi.setSystemTime(startedAt);
      const source = new Rome2RioDiscoverySource({ getRoutes: async () => {
        vi.setSystemTime(rolledBackAt);
        if (outcome === "opaque") return {}; // Synthetic transport value, not a native fixture.
        if (outcome === "unexpected") throw new Error("SYNTHETIC-SECRET");
        throw new Rome2RioClientError(outcome);
      } }, mockPermission());
      const result = await source.discover(discoveryRequest(), context());
      const diagnostic = outcome === "opaque" ? "source_unavailable" : outcome === "unexpected" ? "internal_error"
        : outcome === "timeout" ? "deadline_exceeded" : outcome;
      expect(result).toMatchObject({
        startedAt, finishedAt: startedAt, status: outcome === "timeout" ? "timeout" : "error", diagnostics: [diagnostic],
      });
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
      expectCanonical(result);
    },
  );

  it.each([
    ["millisecond rollback", "2026-10-06T12:00:00.499Z", "2026-10-06T12:00:00.500Z"],
    ["equal clock", "2026-10-06T12:00:00.500Z", "2026-10-06T12:00:00.500Z"],
    ["forward clock", "2026-10-06T12:00:00.501Z", "2026-10-06T12:00:00.501Z"],
  ])("uses the correct completion instant for %s", async (_label, observed, expected) => {
    const start = "2026-10-06T12:00:00.500Z";
    vi.useFakeTimers(); vi.setSystemTime(start);
    const source = new Rome2RioDiscoverySource({ getRoutes: async () => {
      vi.setSystemTime(observed); return {};
    } }, mockPermission());
    const result = await source.discover(discoveryRequest(), context());
    expect(result).toMatchObject({ startedAt: start, finishedAt: expected, status: "error", diagnostics: ["source_unavailable"] });
    expectCanonical(result);
  });

  it.each([
    ["already cancelled", "cancelled"], ["unknown rights", "access_denied"], ["disabled source", "access_denied"],
    ["invalid deadline", "unsupported_request"], ["unrepresentable deadline", "unsupported_request"],
    ["elapsed deadline", "deadline_exceeded"],
  ] as const)("clamps a %s early return without invoking the client", async (scenario, diagnostic) => {
    vi.useFakeTimers(); vi.setSystemTime(startedAt);
    const controller = new AbortController();
    if (scenario === "already cancelled") controller.abort();
    const aborted = controller.signal.aborted;
    // Roll back after start capture, at the first context check, including synchronous exits.
    vi.spyOn(controller.signal, "aborted", "get").mockImplementationOnce(() => {
      vi.setSystemTime(rolledBackAt); return aborted;
    });
    const definition = scenario === "unknown rights" ? createRome2RioSourceDefinition() : mockPermission();
    if (scenario === "disabled source") definition.productionUse.status = "disabled";
    const deadline = scenario === "invalid deadline" ? "invalid" : scenario === "unrepresentable deadline"
      ? "2027-01-01T00:00:00Z" : scenario === "elapsed deadline" ? rolledBackAt : null;
    const client: Rome2RioClient = { getRoutes: vi.fn() };
    const result = await new Rome2RioDiscoverySource(client, definition).discover(discoveryRequest(), context(controller.signal, deadline));
    expect(result).toMatchObject({
      startedAt, finishedAt: startedAt, status: diagnostic === "deadline_exceeded" ? "timeout" : "error", diagnostics: [diagnostic],
    });
    expectCanonical(result, definition);
    expect(client.getRoutes).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("clamps cancellation between invocation and the deferred client call", async () => {
    vi.useFakeTimers(); vi.setSystemTime(startedAt);
    const controller = new AbortController();
    const client: Rome2RioClient = { getRoutes: vi.fn() };
    const pending = new Rome2RioDiscoverySource(client, mockPermission()).discover(
      discoveryRequest(), context(controller.signal, "2026-10-06T12:01:00Z"),
    );
    vi.setSystemTime(rolledBackAt); controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ startedAt, finishedAt: startedAt, status: "error", diagnostics: ["cancelled"] });
    expectCanonical(result);
    expect(client.getRoutes).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it.each([
    ["timeout", "resolve"], ["timeout", "reject"], ["cancelled", "resolve"], ["cancelled", "reject"],
  ] as const)("cleans up after rollback and %s with late client %s", async (outcome, lateOutcome) => {
    vi.useFakeTimers(); vi.setSystemTime(startedAt);
    const controller = new AbortController();
    let clientSignal: AbortSignal | undefined;
    let resolveLater: (value: unknown) => void = () => {};
    let rejectLater: (error: Error) => void = () => {};
    const unhandled = vi.fn(), completed = vi.fn();
    const client: Rome2RioClient = { getRoutes: vi.fn((_request, ctx) => {
      clientSignal = ctx.signal;
      return new Promise((resolve, reject) => { resolveLater = resolve; rejectLater = reject; });
    }) };
    process.on("unhandledRejection", unhandled);
    try {
      const pending = new Rome2RioDiscoverySource(client, mockPermission()).discover(
        discoveryRequest(), context(controller.signal, "2026-10-06T12:00:00.010Z"),
      );
      void pending.then(completed, () => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getRoutes).toHaveBeenCalledTimes(1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      vi.setSystemTime(rolledBackAt);
      if (outcome === "cancelled") controller.abort("SYNTHETIC-SECRET");
      else await vi.advanceTimersByTimeAsync(10);
      const result = await pending;
      expect(result).toMatchObject({
        startedAt, finishedAt: startedAt, status: outcome === "timeout" ? "timeout" : "error",
        diagnostics: [outcome === "timeout" ? "deadline_exceeded" : "cancelled"],
      });
      expectCanonical(result);
      expect(clientSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toEqual([]);
      const snapshot = structuredClone(result);
      if (lateOutcome === "reject") rejectLater(new Error("SYNTHETIC-SECRET"));
      else resolveLater({ arbitrary: "SYNTHETIC-SECRET" });
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);
      expect(unhandled).not.toHaveBeenCalled();
      expect(completed).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toEqual([]);
      expect(result).toEqual(snapshot);
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });
});
