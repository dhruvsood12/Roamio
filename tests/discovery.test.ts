import { describe, expect, it } from "vitest";
import {
  DiscoverySourceDefinitionSchema, EstimatedPriceSchema, FlightOfferSchema, LocationRefSchema,
  PaymentQuoteSchema, RouteCandidateLegSchema, RouteCandidateSchema, RouteDiscoveryCapabilitiesSchema,
  RouteDiscoveryRequestSchema, RouteDiscoveryResultSchema, RouteEvidenceSchema, TransportModeSchema,
  TripOptionSchema, TripPaymentSummarySchema, createTripOption,
  type EstimatedPrice, type FlightOffer, type PaymentQuote, type RouteCandidate, type RouteDiscoveryResult,
} from "@flightbrain/domain";
import { validateRouteDiscoveryResult, type RouteDiscoverySource } from "@flightbrain/discovery";
import {
  airportLocation, cityLocation, discoveryDefinition, discoveryEvidence, discoveryLeg, discoveryRequest,
  discoveryResult, flightCandidate, multimodalCandidate, scheduledCandidate,
} from "./fixtures/discovery";
import { singlePlan } from "./fixtures/trips";

function freezeDeep(value: unknown): void {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
}
function rejectCandidate(raw: unknown) {
  expect(() => RouteCandidateSchema.safeParse(raw)).not.toThrow();
  expect(RouteCandidateSchema.safeParse(raw).success).toBe(false);
}

describe("discovery locations and intent", () => {
  it.each(["flight", "rail", "bus", "ferry", "car", "rideshare", "walk", "other"])("supports %s without assuming flights", mode => {
    expect(TransportModeSchema.parse(mode)).toBe(mode);
    expect(RouteDiscoveryCapabilitiesSchema.parse({ ...discoveryDefinition().capabilities, modes: [mode], multimodal: false }).modes).toEqual([mode]);
  });
  it("models a transfer as a movement role rather than a mode or protection claim", () => {
    expect(TransportModeSchema.safeParse("ground_transfer").success).toBe(false);
    const candidate = flightCandidate(); candidate.legs[0].mode = "walk"; candidate.legs[0].role = "transfer";
    rejectCandidate(candidate);
    candidate.evidence.push({ ...discoveryEvidence(), factType: "transfer" });
    expect(RouteCandidateSchema.parse(candidate).legs[0]).toMatchObject({ role: "transfer", mode: "walk" });
    expect(RouteCandidateLegSchema.safeParse({ ...candidate.legs[0], protected: true }).success).toBe(false);
  });
  it.each(["rail_station", "bus_station", "ferry_terminal", "other_hub"])("namespaces native %s IDs", kind => {
    const location = { kind, reference: { sourceId: "synthetic-feed-a", id: "stop-1" }, name: null, coordinates: null };
    const a = LocationRefSchema.parse(location);
    const b = LocationRefSchema.parse({ ...location, reference: { sourceId: "synthetic-feed-b", id: "stop-1" } });
    expect(a).not.toEqual(b);
    expect(LocationRefSchema.safeParse({ ...location, reference: { id: "stop-1" } }).success).toBe(false);
    expect(LocationRefSchema.parse(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });
  it.each([
    airportLocation("ARN"), cityLocation("Stockholm", "SE"),
    { kind: "metro_area", name: "London", countryCode: "GB", reference: null },
    { kind: "point", coordinates: { latitude: -90, longitude: 180 } },
    { kind: "point", coordinates: { latitude: 90, longitude: -180 } },
    { kind: "address", address: "Synthetic public meeting point", countryCode: null },
  ])("round-trips a typed location %j", location => {
    expect(LocationRefSchema.parse(JSON.parse(JSON.stringify(location)))).toEqual(location);
  });
  it.each([
    { kind: "airport", iataCode: "arn" }, { kind: "city", iataCode: "NYC" },
    { kind: "point", coordinates: { latitude: 90.01, longitude: 0 } },
    { kind: "point", coordinates: { latitude: 0, longitude: -180.01 } },
    { kind: "point", coordinates: { latitude: NaN, longitude: 0 } },
    { kind: "point", coordinates: { latitude: 0, longitude: Infinity } },
    { kind: "point", coordinates: { latitude: "0", longitude: 0 } },
    { kind: "external", id: "unscoped-id" },
  ])("rejects malformed or ambiguous location %j", location => expect(LocationRefSchema.safeParse(location).success).toBe(false));

  it.each([
    { kind: "unspecified" }, { kind: "date", date: "2028-02-29" },
    { kind: "window", startAt: "2026-10-10T08:00:00+02:00", endAt: "2026-10-10T07:00:00Z" },
  ])("supports explicit departure intent %j", departure => {
    const request = RouteDiscoveryRequestSchema.parse({ ...discoveryRequest(), departure });
    expect(RouteDiscoveryRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });
  it.each([
    { departure: { kind: "date", date: "2026-02-29" } },
    { departure: { kind: "window", startAt: "2026-10-10T08:00:00+02:00", endAt: "2026-10-10T06:00:00Z" } },
    { departure: { kind: "unspecified", date: "2026-10-10" } },
    { allowedModes: [] }, { allowedModes: ["rail", "rail"] }, { maxIntermediateStops: -1 },
    { passengers: { count: 0 } }, { passengers: { count: 1.5 } }, { cabins: ["business"] },
    { payment: "cash" }, { requestId: " padded" },
  ])("rejects invalid request %j", change => expect(RouteDiscoveryRequestSchema.safeParse({ ...discoveryRequest(), ...change }).success).toBe(false));
  it("retains unknown capabilities rather than converting them into false or true", () => {
    const caps = { modes: null, multimodal: null, dateFiltering: null, schedules: null, estimatedPrices: null, realtime: null, geography: { kind: "unknown" } };
    expect(RouteDiscoveryCapabilitiesSchema.parse(caps)).toEqual(caps);
    expect(RouteDiscoveryCapabilitiesSchema.safeParse({ ...caps, modes: ["rail"], multimodal: true }).success).toBe(false);
    expect(RouteDiscoveryCapabilitiesSchema.safeParse({ ...caps, geography: { kind: "countries", countries: ["SE", "SE"] } }).success).toBe(false);
  });
});

describe("candidate facts and evidence", () => {
  it("preserves DEL–NRT–LAX–SFO as three ordered discovery movements", () => {
    const candidate = flightCandidate();
    expect(candidate.legs.map(l => [l.order, l.origin, l.destination])).toEqual([
      [0, airportLocation("DEL"), airportLocation("NRT")], [1, airportLocation("NRT"), airportLocation("LAX")],
      [2, airportLocation("LAX"), airportLocation("SFO")],
    ]);
    expect(candidate.legs.every(l => l.operator === null && l.serviceRef === null && l.departureAt === null && l.arrivalAt === null && l.scheduleState === "unknown")).toBe(true);
    expect(candidate.estimatedPrice).toBeNull(); expect(candidate.estimatedDurationMinutes).toBeNull();
  });
  it("supports Stockholm–rail–Copenhagen–flight–Tokyo without inventing flight identities", () => {
    const candidate = multimodalCandidate();
    expect(candidate.legs.map(l => l.mode)).toEqual(["rail", "flight"]);
    expect(candidate.legs[0].origin).toEqual(cityLocation("Stockholm", "SE"));
    expect(candidate.legs[1].destination).toEqual(cityLocation("Tokyo", "JP"));
    expect(candidate.legs.every(l => l.serviceRef === null)).toBe(true);
  });
  it("keeps scheduled topology and an estimated price as distinct targeted facts", () => {
    const candidate = scheduledCandidate();
    expect(candidate.evidence.map(e => [e.factType, e.level, e.target])).toEqual([
      ["route_exists", "scheduled", { kind: "leg", legIndex: 0 }],
      ["schedule", "scheduled", { kind: "leg", legIndex: 0 }],
      ["estimated_price", "estimated", { kind: "candidate" }],
    ]);
    expect(candidate.estimatedPrice?.amount.amountMinor).toBe("3100000");
    expect(candidate.estimatedPrice?.basis).toBe("unknown");
  });
  it("supports heuristic-only hints without automatic evidence upgrades", () => {
    const candidate = flightCandidate("roamio-hub-heuristic"); candidate.source.kind = "heuristic";
    expect(RouteCandidateSchema.parse(candidate)).toEqual(candidate);
    candidate.evidence[0].level = "scheduled";
    rejectCandidate(candidate);
  });
  it("requires provenance and evidence for known operator/service/duration facts", () => {
    const candidate = flightCandidate();
    Object.assign(candidate.legs[0], { operator: { name: "Synthetic Rail", reference: null },
      serviceRef: { sourceId: "synthetic-source", id: "service-12" }, estimatedDurationMinutes: 10 });
    rejectCandidate(candidate);
    candidate.evidence.push(
      { ...discoveryEvidence(), factType: "operator" }, { ...discoveryEvidence(), factType: "service_identity" },
      { ...discoveryEvidence(), factType: "duration", level: "estimated" },
    );
    expect(RouteCandidateSchema.parse(candidate)).toEqual(candidate);
  });
  it("allows partially known and observed schedules, independent of commercial inventory", () => {
    const candidate = scheduledCandidate(); candidate.legs[0].arrivalAt = null;
    expect(RouteCandidateSchema.parse(candidate).legs[0].arrivalAt).toBeNull();
    candidate.legs[0].scheduleState = "observed"; candidate.evidence[1] = { ...candidate.evidence[1], factType: "schedule", level: "observed" };
    expect(RouteCandidateSchema.parse(candidate).legs[0].scheduleState).toBe("observed");
  });
  it("retains stale evidence and provider clock differences without upgrading freshness", () => {
    const candidate = flightCandidate();
    Object.assign(candidate.evidence[0], { observedAt: "2026-09-22T10:00:00Z", expiresAt: "2026-09-20T10:00:00Z" });
    expect(RouteCandidateSchema.parse(candidate).evidence[0]).toEqual(candidate.evidence[0]);
  });
  it("retains unresolved spatial gaps without inventing a feasible surface connection", () => {
    const candidate = flightCandidate(); candidate.legs[1].origin = airportLocation("HND");
    expect(RouteCandidateSchema.parse(candidate).legs[1].origin).toEqual(airportLocation("HND"));
    expect(candidate.legs).toHaveLength(3);
  });
  const changes: [string, (c: RouteCandidate) => void][] = [
    ["wrong leg order", c => { c.legs[1].order = 0; }],
    ["missing route evidence", c => { c.evidence.pop(); }],
    ["other source evidence", c => { c.evidence[0].sourceId = "another-source"; }],
    ["missing evidence target", c => { c.evidence[0].target = { kind: "leg", legIndex: 100 }; }],
    ["unsubstantiated price", c => { c.estimatedPrice = scheduledCandidate().estimatedPrice; }],
    ["unsubstantiated duration", c => { c.estimatedDurationMinutes = 120; }],
    ["price evidence without a price", c => { c.evidence.push({ ...discoveryEvidence(null), factType: "estimated_price", level: "estimated" }); }],
    ["operator evidence without operator", c => { c.evidence.push({ ...discoveryEvidence(), factType: "operator" }); }],
    ["service evidence without service", c => { c.evidence.push({ ...discoveryEvidence(), factType: "service_identity" }); }],
    ["transfer evidence on travel", c => { c.evidence.push({ ...discoveryEvidence(), factType: "transfer" }); }],
    ["unknown schedule with a time", c => { c.legs[0].departureAt = "2026-10-10T00:00:00Z"; }],
    ["known schedule without any time", c => { c.legs[0].scheduleState = "scheduled"; }],
  ];
  it.each(changes)("rejects $0", (_, mutate) => { const candidate = flightCandidate(); mutate(candidate); rejectCandidate(candidate); });
  it.each(["quoted", "revalidated", "estimated", "observed"])("does not relabel estimated price evidence as %s", level => {
    const evidence = { ...discoveryEvidence(null), factType: "estimated_price", level };
    expect(RouteEvidenceSchema.safeParse(evidence).success).toBe(level === "estimated");
  });
  it.each(["quoted", "revalidated"])("rejects discovery route evidence level %s", level => {
    expect(RouteEvidenceSchema.safeParse({ ...discoveryEvidence(), level }).success).toBe(false);
  });
  it("rejects schedule evidence attached to the wrong fact or level", () => {
    const candidate = scheduledCandidate(); candidate.evidence[1].target = { kind: "candidate" }; rejectCandidate(candidate);
    candidate.evidence[1] = { ...discoveryEvidence(), factType: "schedule", level: "observed" }; rejectCandidate(candidate);
  });
  it.each(["2026-10-10T00:00:00Z", "2026-10-09T23:00:00Z"])("rejects nonpositive elapsed service time %s", arrivalAt => {
    const candidate = scheduledCandidate(); candidate.legs[0].arrivalAt = arrivalAt; rejectCandidate(candidate);
  });
  it("rejects known overlap across adjacent candidate legs", () => {
    const candidate = scheduledCandidate();
    candidate.legs.push({ ...candidate.legs[0], order: 1 });
    candidate.evidence.push(discoveryEvidence(1), { ...discoveryEvidence(1), factType: "schedule", level: "scheduled" });
    rejectCandidate(candidate);
  });
});

describe("candidate chronology across partial schedules", () => {
  type LegTimes = [string | null, string | null];
  function resultWithTimes(times: LegTimes[]): RouteDiscoveryResult {
    const result = discoveryResult();
    const candidate = result.candidates[0];
    times.forEach(([departure, arrival], index) => {
      const leg = candidate.legs[index];
      leg.departureAt = departure === null ? null : `2026-10-10T${departure}`;
      leg.arrivalAt = arrival === null ? null : `2026-10-10T${arrival}`;
      if (departure !== null || arrival !== null) {
        leg.scheduleState = "scheduled";
        candidate.evidence.push({ ...discoveryEvidence(index), factType: "schedule", level: "scheduled" });
      }
    });
    return result;
  }

  const reversed: [string, LegTimes[], number, "departureAt" | "arrivalAt"][] = [
    ["known legs separated by an unknown leg", [["10:00:00Z", "11:00:00Z"], [null, null], ["09:00:00Z", "10:00:00Z"]], 2, "departureAt"],
    ["departure followed by an earlier arrival", [["08:00:00Z", null], [null, "07:00:00Z"]], 1, "arrivalAt"],
    ["arrival followed by an earlier departure", [[null, "12:00:00Z"], ["11:00:00Z", null]], 1, "departureAt"],
    ["two known departures with unknown arrivals", [["08:00:00Z", null], ["07:00:00Z", null]], 1, "departureAt"],
    ["two known arrivals with unknown departures", [[null, "08:00:00Z"], [null, "07:00:00Z"]], 1, "arrivalAt"],
    ["one millisecond reversal across null events", [[null, "08:00:00.101Z"], [null, null], ["08:00:00.100Z", null]], 2, "departureAt"],
    ["offset spelling that appears later but is an earlier instant", [["08:00:00Z", null], [null, "09:00:00+02:00"]], 1, "arrivalAt"],
  ];
  it.each(reversed)("rejects %s at the full boundary without mutating input", (_, times, legIndex, field) => {
    const result = resultWithTimes(times);
    const before = structuredClone(result);
    freezeDeep(result);
    const parsed = RouteCandidateSchema.safeParse(result.candidates[0]);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["legs", legIndex, field] }),
    ]));
    expect(() => validateRouteDiscoveryResult(result, discoveryDefinition(), discoveryRequest())).toThrow();
    expect(result).toEqual(before);
  });

  const ordered: [string, LegTimes[]][] = [
    ["correctly ordered partial adjacent legs", [["08:00:00Z", null], [null, "12:00:00Z"]]],
    ["correctly ordered known legs around an unknown leg", [["08:00:00Z", "09:00:00Z"], [null, null], ["12:00:00Z", "13:00:00Z"]]],
    ["all timestamps unknown", [[null, null], [null, null], [null, null]]],
    ["only one departure known", [[null, null], ["08:00:00Z", null], [null, null]]],
    ["only one arrival known", [[null, null], [null, "08:00:00Z"], [null, null]]],
    ["zero-gap arrival and next departure", [["07:00:00Z", "08:00:00Z"], ["08:00:00Z", "09:00:00Z"]]],
    ["equal instants from UTC to an offset", [[null, "08:00:00Z"], ["10:00:00+02:00", null]]],
    ["equal instants from an offset to UTC", [[null, "10:00:00+02:00"], ["08:00:00Z", null]]],
    ["one millisecond progression across null events", [[null, "08:00:00.100Z"], [null, null], ["08:00:00.101Z", null]]],
    ["equal fractional instants across null events", [[null, "08:00:00.1Z"], [null, null], ["08:00:00.100Z", null]]],
  ];
  it.each(ordered)("accepts %s without inferring times or mutating input", (_, times) => {
    const result = resultWithTimes(times);
    const before = structuredClone(result);
    freezeDeep(result);
    const output = validateRouteDiscoveryResult(result, discoveryDefinition(), discoveryRequest());
    // Preserve nulls, duration estimates, evidence and original timestamp spellings.
    expect(output).toEqual(before);
    expect(result).toEqual(before);
    expect(output.candidates[0].legs).not.toBe(result.candidates[0].legs);
  });
});

describe("commercial boundaries", () => {
  it("rejects discovery candidates as FlightOffers and TripOptions at runtime and in TypeScript", () => {
    const candidate = flightCandidate();
    expect(FlightOfferSchema.safeParse(candidate).success).toBe(false);
    expect(TripOptionSchema.safeParse(candidate).success).toBe(false);
    // @ts-expect-error A discovery observation is not a commercial offer.
    const offer: FlightOffer = candidate;
    void offer;
  });
  it("keeps estimates out of PaymentQuote, TripOption and cash summary contracts", () => {
    const estimate: EstimatedPrice = scheduledCandidate().estimatedPrice!;
    expect(PaymentQuoteSchema.safeParse(estimate).success).toBe(false);
    expect(TripPaymentSummarySchema.safeParse({ cashByCurrency: [estimate], pointsByProgram: [] }).success).toBe(false);
    const trip = createTripOption(singlePlan());
    expect(TripOptionSchema.safeParse({ ...trip, payment: estimate }).success).toBe(false);
    expect(TripOptionSchema.safeParse({ ...trip, bookingComponents: [{ ...trip.bookingComponents[0], payment: estimate }] }).success).toBe(false);
    // @ts-expect-error An estimate is not an authoritative payment obligation.
    const quote: PaymentQuote = estimate;
    void quote;
  });
  it.each([
    { kind: "cash" }, { confidence: 0.8 }, { scheduleFingerprint: "fb:schedule:v1:" + "a".repeat(64) },
    { totalPrice: { amountMinor: "100", currency: "USD", exponent: 2 } }, { bookingUrl: "https://example.test/book" },
  ])("rejects commercial or universal confidence fields on candidates %j", change => rejectCandidate({ ...flightCandidate(), ...change }));
  it("requires exact money and explicit estimate basis without FX or coercion", () => {
    const estimate = scheduledCandidate().estimatedPrice!;
    expect(EstimatedPriceSchema.safeParse({ ...estimate, amount: { ...estimate.amount, amountMinor: 100 } }).success).toBe(false);
    expect(EstimatedPriceSchema.safeParse({ ...estimate, amount: { ...estimate.amount, exponent: 0 } }).success).toBe(false);
    expect(EstimatedPriceSchema.safeParse({ kind: "estimate", amount: estimate.amount }).success).toBe(false);
  });
});

describe("source registry, result state and source binding", () => {
  it("defaults every independent rights decision conservatively", () => {
    const source = discoveryDefinition();
    expect(source.productionUse.status).toBe("unknown");
    expect(Object.values(source.persistencePolicy).every(p => p.status === "unknown")).toBe(true);
    expect(Object.values(source.redistributionPolicy).every(p => p.status === "unknown")).toBe(true);
    source.persistencePolicy.cache.status = "denied";
    expect(source.persistencePolicy.persist.status).toBe("unknown");
    expect(discoveryDefinition().persistencePolicy.cache.status).toBe("unknown");
  });
  it("requires attributed review for approval and known rights, with no implied permissions", () => {
    const source = discoveryDefinition(); source.productionUse.status = "approved";
    expect(DiscoverySourceDefinitionSchema.safeParse(source).success).toBe(false);
    Object.assign(source.productionUse, { reviewedAt: "2026-09-21T10:00:00Z", reference: "synthetic-review" });
    expect(DiscoverySourceDefinitionSchema.parse(source).persistencePolicy.persist.status).toBe("unknown");
    source.persistencePolicy.cache.status = "allowed";
    expect(DiscoverySourceDefinitionSchema.safeParse(source).success).toBe(false);
    Object.assign(source.persistencePolicy.cache, { reviewedAt: "2026-09-21T10:00:00Z", reference: "synthetic-cache-review" });
    expect(DiscoverySourceDefinitionSchema.parse(source).redistributionPolicy.redistribute.status).toBe("unknown");
  });
  it.each(["mcp", "api", "gtfs", "gtfs_realtime", "open_data", "heuristic", "other"])("represents %s access without granting production rights", accessMethod => {
    const source = DiscoverySourceDefinitionSchema.parse({ ...discoveryDefinition(), accessMethod });
    expect(source.productionUse.status).toBe("unknown");
  });
  it.each(["experimental", "unknown", "restricted", "disabled"])("retains %s production state", status => {
    expect(DiscoverySourceDefinitionSchema.parse({ ...discoveryDefinition(), productionUse: { status } }).productionUse.status).toBe(status);
  });
  it.each(["partial", "timeout", "error"])("retains accepted candidates during %s completion", status => {
    const result = RouteDiscoveryResultSchema.parse({ ...discoveryResult(), status });
    expect(result.candidates).toHaveLength(1); expect(result.status).toBe(status);
    expect(RouteDiscoveryResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });
  it("distinguishes successful empty enumeration from an empty failure", () => {
    const empty = discoveryResult([]);
    const failed = RouteDiscoveryResultSchema.parse({ ...empty, status: "error", diagnostics: ["source_unavailable"] });
    expect(empty.status).toBe("success"); expect(failed.status).toBe("error");
    expect(empty.candidates).toEqual(failed.candidates);
  });
  it("preserves separate source observations of the identical path", () => {
    const a = flightCandidate("synthetic-source"); const b = flightCandidate("other-source");
    const first = discoveryResult([a]);
    const second = RouteDiscoveryResultSchema.parse({ ...discoveryResult([]), sourceId: "other-source", candidates: [b] });
    expect(first.candidates[0].legs).toEqual(second.candidates[0].legs);
    expect(first.candidates[0].source).not.toEqual(second.candidates[0].source);
    expect(second.candidates[0].evidence.every(e => e.sourceId === "other-source")).toBe(true);
  });
  it("preserves repeated routes with distinct occurrence IDs rather than deduplicating", () => {
    const a = flightCandidate(); const b = { ...flightCandidate(), id: "occurrence-2" };
    expect(discoveryResult([a, b]).candidates).toEqual([a, b]);
    expect(RouteDiscoveryResultSchema.safeParse({ ...discoveryResult(), candidates: [a, a] }).success).toBe(false);
  });
  it.each([
    { sourceId: "other-source" }, { requestId: "other-request" }, { finishedAt: "2026-09-21T09:59:59Z" },
    { diagnostics: ["raw exception message"] },
  ])("rejects incoherent result envelope %j", change => expect(RouteDiscoveryResultSchema.safeParse({ ...discoveryResult(), ...change }).success).toBe(false));
  it("binds canonical results to the invoked source/request and declared capabilities", () => {
    const source = discoveryDefinition(); const request = discoveryRequest(); const result = discoveryResult();
    expect(validateRouteDiscoveryResult(result, source, request)).toEqual(result);
    expect(() => validateRouteDiscoveryResult(result, { ...source, id: "other-source" }, request)).toThrow();
    expect(() => validateRouteDiscoveryResult(result, source, { ...request, requestId: "other-request" })).toThrow();
    expect(() => validateRouteDiscoveryResult(result, { ...source, accessMethod: "heuristic" }, request)).toThrow();
    expect(() => validateRouteDiscoveryResult(result, { ...source, capabilities: { ...source.capabilities, modes: ["rail"], multimodal: false } }, request)).toThrow();
    expect(() => validateRouteDiscoveryResult(discoveryResult([multimodalCandidate()]), { ...source, capabilities: { ...source.capabilities, multimodal: false } }, request)).toThrow();
    expect(() => validateRouteDiscoveryResult(discoveryResult([scheduledCandidate()]), { ...source, capabilities: { ...source.capabilities, schedules: false } }, request)).toThrow();
    expect(() => validateRouteDiscoveryResult(discoveryResult([scheduledCandidate()]), { ...source, capabilities: { ...source.capabilities, estimatedPrices: false } }, request)).toThrow();
  });
  it("supports a stateless synthetic RouteDiscoverySource without FlightProvider or network calls", async () => {
    const definition = discoveryDefinition();
    const source: RouteDiscoverySource = {
      id: definition.id, capabilities: definition.capabilities,
      async discover(request, context) {
        expect(context.signal.aborted).toBe(false); expect(context.deadlineAt).toBeNull();
        return validateRouteDiscoveryResult(discoveryResult(), definition, request);
      },
    };
    expect((await source.discover(discoveryRequest(), { signal: new AbortController().signal, deadlineAt: null })).candidates).toHaveLength(1);
  });
  it("clones validated JSON data and leaves deeply frozen source inputs unchanged", () => {
    const source = discoveryDefinition(); const request = discoveryRequest(); const input = discoveryResult([scheduledCandidate()]);
    const before = structuredClone({ source, request, input }); freezeDeep(source); freezeDeep(request); freezeDeep(input);
    const output = validateRouteDiscoveryResult(input, source, request);
    expect(RouteDiscoveryResultSchema.parse(JSON.parse(JSON.stringify(output)))).toEqual(output);
    expect(DiscoverySourceDefinitionSchema.parse(JSON.parse(JSON.stringify(source)))).toEqual(source);
    output.candidates[0].estimatedPrice!.amount.amountMinor = "1";
    output.candidates[0].legs[0].origin = airportLocation("ARN");
    expect({ source, request, input }).toEqual(before);
  });
});

describe("strict discovery security boundary", () => {
  const secrets = { accessToken: "SYNTHETIC-SECRET", rawResponse: { privateFareCode: "SYNTHETIC-PRIVATE" } };
  const places: [string, (r: RouteDiscoveryResult) => object][] = [
    ["result", r => r], ["candidate", r => r.candidates[0]], ["source ref", r => r.candidates[0].source],
    ["leg", r => r.candidates[0].legs[0]], ["location", r => r.candidates[0].legs[0].origin],
    ["evidence", r => r.candidates[0].evidence[0]], ["evidence target", r => r.candidates[0].evidence[0].target],
    ["estimate", r => r.candidates[0].estimatedPrice!], ["money", r => r.candidates[0].estimatedPrice!.amount],
  ];
  it.each(places)("rejects private source payloads in %s instead of serializing them", (_, select) => {
    const result = discoveryResult([scheduledCandidate()]);
    Object.assign(select(result), { providerMetadata: { nested: [secrets] } });
    const parsed = RouteDiscoveryResultSchema.safeParse(result);
    expect(parsed.success).toBe(false);
    expect(() => validateRouteDiscoveryResult(result, discoveryDefinition(), discoveryRequest())).toThrow();
  });
  it.each(["metadata", "raw", "providerData", "headers", "credentials", "sessionId", "apiKey", "oauthToken"])("rejects unsafe candidate field %s", field => rejectCandidate({ ...flightCandidate(), [field]: secrets }));
  it("rejects secrets on registry metadata, rights, capabilities and requests", () => {
    const source = discoveryDefinition();
    expect(DiscoverySourceDefinitionSchema.safeParse({ ...source, credentials: secrets }).success).toBe(false);
    expect(DiscoverySourceDefinitionSchema.safeParse({ ...source, capabilities: { ...source.capabilities, raw: secrets } }).success).toBe(false);
    expect(DiscoverySourceDefinitionSchema.safeParse({ ...source, productionUse: { ...source.productionUse, headers: secrets } }).success).toBe(false);
    expect(RouteDiscoveryRequestSchema.safeParse({ ...discoveryRequest(), metadata: secrets }).success).toBe(false);
  });
  it("keeps synthetic secrets out of every accepted serialized contract", () => {
    const contracts = [discoveryRequest(), discoveryDefinition(), flightCandidate(), multimodalCandidate(), scheduledCandidate(), discoveryResult()];
    for (const value of contracts) for (const marker of ["accessToken", "SYNTHETIC-SECRET", "rawResponse", "privateFareCode", "SYNTHETIC-PRIVATE"]) {
      expect(JSON.stringify(value)).not.toContain(marker);
    }
  });
  it.each([1n, new Map(), new Set(), new Date(), Infinity, NaN, () => 1])("rejects non-JSON values at a typed public field %s", value => {
    rejectCandidate({ ...flightCandidate(), estimatedDurationMinutes: value });
  });
});
