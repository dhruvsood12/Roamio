import { describe, expect, it } from "vitest";
import {
  BookingComponentSchema, ConnectionSchema, createTripOption, FlightOfferSchema,
  TripOptionSchema, TripPlanSchema, type TripOption, type TripPlan,
} from "@flightbrain/domain";
import { itineraryFingerprint } from "@flightbrain/orchestrator";
import { connectingRoundTrip, offerWithJourneys } from "./fixtures/journeys";
import { planFor, singlePlan, splitPlan, syntheticOffer, tripSegments } from "./fixtures/trips";

function invalidPlan(plan: unknown) {
  expect(() => TripPlanSchema.safeParse(plan)).not.toThrow();
  expect(TripPlanSchema.safeParse(plan).success).toBe(false);
}
function roundTripPlan(): TripPlan {
  const source = offerWithJourneys(connectingRoundTrip());
  const plan = planFor([source]);
  plan.journeys = source.journeys.map((j, journeyIndex) => ({
    requestedOrigin: j.segments[0].origin, requestedDestination: j.segments.at(-1)!.destination,
    segments: j.segments.map((_, segmentIndex) => ({ componentIndex: 0, journeyIndex, segmentIndex })),
  })) as TripPlan["journeys"];
  return plan;
}
function freezeDeep(value: unknown): void {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
}

describe("complete trip contracts", () => {
  it("represents a direct DEL–SFO cash trip with one independent component", () => {
    const segment = { ...tripSegments()[0], destination: "SFO" };
    const plan = planFor([syntheticOffer([segment], "direct")]);
    const trip = createTripOption(plan);
    expect(trip.travel).toMatchObject({ firstDepartureAt: "2026-10-10T00:00:00.000Z", finalArrivalAt: "2026-10-10T08:00:00.000Z",
      durationMilliseconds: 8 * 3_600_000, segmentCount: 1, bookingComponentCount: 1 });
    expect(trip.travel.journeys[0]).toMatchObject({ requestedOrigin: "DEL", requestedDestination: "SFO" });
    expect(trip.payment).toEqual({ cashByCurrency: [plan.sourceOffers[0].totalPrice], pointsByProgram: [] });
    expect(trip.connections).toEqual([]); expect(trip.warnings).toEqual([]);
    expect(trip.sourceOffers).toEqual(plan.sourceOffers.map(({ providerMetadata, ...snapshot }) => snapshot));
    expect(trip.sourceOffers[0]).not.toHaveProperty("providerMetadata");
  });
  it("preserves three commercial components along DEL–NRT–LAX–SFO", () => {
    const trip = createTripOption(splitPlan());
    expect(trip.travel.segmentCount).toBe(3); expect(trip.travel.bookingComponentCount).toBe(3);
    expect(trip.travel.durationMilliseconds).toBe(24 * 3_600_000);
    expect(trip.connections.map((c) => [c.fromComponentIndex, c.toComponentIndex, c.protection])).toEqual([[0, 1, "self_transfer"], [1, 2, "self_transfer"]]);
    expect(trip.connections.every((c) => c.evidence.kind === "separate_bookings")).toBe(true);
    expect(trip.warnings).toEqual(["self_transfer", "multiple_booking_components"]);
  });
  it("keeps identical physical schedules with different booking boundaries distinct", () => {
    const single = createTripOption(singlePlan()); const split = createTripOption(splitPlan());
    expect(single.sourceOffers[0].journeys[0].segments).toEqual(split.sourceOffers.flatMap((o) => o.journeys[0].segments));
    expect(single.travel.durationMilliseconds).toBe(split.travel.durationMilliseconds);
    expect(single.bookingComponents).toHaveLength(1); expect(split.bookingComponents).toHaveLength(3);
    expect(single.connections.map((c) => c.protection)).toEqual(["unknown", "unknown"]);
    expect(single.warnings).toEqual(["unknown_connection_protection"]);
    expect(split.connections.map((c) => c.crossesBookingBoundary)).toEqual([true, true]);
  });
  it("retains round-trip boundaries without counting destination stays as travel", () => {
    const trip = createTripOption(roundTripPlan());
    expect(trip.travel.journeys.map((j) => j.durationMilliseconds / 60000)).toEqual([900, 840]);
    expect(trip.travel.durationMilliseconds / 60000).toBe(1740);
    expect(trip.connections).toHaveLength(2);
    expect(Date.parse(trip.travel.finalArrivalAt) - Date.parse(trip.travel.firstDepartureAt)).toBeGreaterThan(trip.travel.durationMilliseconds);
  });
  it("represents open-jaw endpoints without inventing a connection during a destination stay", () => {
    const plan = roundTripPlan(); plan.sourceOffers[0].journeys[1].segments[0].origin = "LAX";
    plan.journeys[1].requestedOrigin = "LAX";
    plan.bookingComponents[0].scheduleFingerprint = itineraryFingerprint(plan.sourceOffers[0]);
    const trip = createTripOption(plan);
    expect(trip.connections).toHaveLength(2); expect(trip.warnings).not.toContain("airport_change");
  });
  it("allows a round-trip component to recur after another component", () => {
    const [outA, outB] = tripSegments();
    const backB = { ...outB, origin: "LAX", destination: "NRT", departureAt: "2026-10-20T00:00:00Z", arrivalAt: "2026-10-20T10:00:00Z" };
    const backA = { ...outA, origin: "NRT", destination: "DEL", departureAt: "2026-10-20T12:00:00Z", arrivalAt: "2026-10-20T20:00:00Z" };
    const a = syntheticOffer([outA], "a"); a.journeys.push({ segments: [backA] });
    const b = syntheticOffer([outB], "b"); b.journeys.push({ segments: [backB] });
    const plan = planFor([a, b]);
    plan.journeys.push({ requestedOrigin: "LAX", requestedDestination: "DEL", segments: [
      { componentIndex: 1, journeyIndex: 1, segmentIndex: 0 }, { componentIndex: 0, journeyIndex: 1, segmentIndex: 0 }] });
    const trip = createTripOption(plan);
    expect(trip.travel.bookingComponentCount).toBe(2);
    expect(trip.connections.map((c) => [c.fromComponentIndex, c.toComponentIndex])).toEqual([[0, 1], [1, 0]]);
  });
  it("does not deduplicate repeated provider IDs or null schedule identities", () => {
    const plan = splitPlan();
    for (let i = 0; i < plan.sourceOffers.length; i++) {
      const source = plan.sourceOffers[i]; source.id = "same"; source.providerOfferId = "same";
      source.journeys[0].segments[0].operatingFlightNumber = null;
      Object.assign(plan.bookingComponents[i], { offerId: "same", providerOfferId: "same", scheduleFingerprint: null });
    }
    const trip = createTripOption(plan);
    expect(trip.bookingComponents).toHaveLength(3); expect(trip.sourceOffers).toHaveLength(3);
    expect(trip.bookingComponents.map((c) => c.sourceOfferIndex)).toEqual([0, 1, 2]);
  });
  it("resolves explicit snapshot references rather than provider IDs or source-array order", () => {
    const plan = splitPlan(); plan.sourceOffers.reverse();
    plan.bookingComponents.forEach((c, i) => { c.sourceOfferIndex = 2 - i; });
    expect(createTripOption(plan).travel.journeys[0].requestedOrigin).toBe("DEL");
  });
});

describe("payment obligations on actual selected components", () => {
  it("represents multi-currency cash without the ranker's mixed-currency exception", () => {
    const plan = splitPlan();
    const amounts = [{ amountMinor: "3100000", currency: "INR" as const, exponent: 2 },
      { amountMinor: "42000", currency: "USD" as const, exponent: 2 }, { amountMinor: "8900", currency: "USD" as const, exponent: 2 }];
    amounts.forEach((amount, i) => { plan.sourceOffers[i].totalPrice = amount; plan.bookingComponents[i].payment = { kind: "cash", amount }; });
    expect(createTripOption(plan).payment.cashByCurrency).toEqual([amounts[0], { amountMinor: "50900", currency: "USD", exponent: 2 }]);
  });
  it("represents hybrid trips without reclassifying separate bookings as one cash-and-points quote", () => {
    const plan = splitPlan();
    plan.bookingComponents[0].payment = { kind: "award", program: { id: "aeroplan" }, points: "55000", taxesAndFees: [] };
    plan.sourceOffers[1].totalPrice.amountMinor = "41000";
    plan.bookingComponents[1].payment = { kind: "cash", amount: plan.sourceOffers[1].totalPrice };
    plan.bookingComponents[2].payment = { kind: "award", program: { id: "united-mileageplus" }, points: "7500", taxesAndFees: [{ amountMinor: "560", currency: "USD", exponent: 2 }] };
    const trip = createTripOption(plan);
    expect(trip.payment).toEqual({ cashByCurrency: [{ amountMinor: "41560", currency: "USD", exponent: 2 }], pointsByProgram: [
      { program: { id: "aeroplan" }, points: "55000" }, { program: { id: "united-mileageplus" }, points: "7500" }] });
    expect(trip.warnings).toContain("mixed_payment");
    expect(trip.bookingComponents.map((c) => c.payment.kind)).toEqual(["award", "cash", "award"]);
  });
  it("does not charge taxes twice on a tax-inclusive cash quote", () => {
    const plan = singlePlan(); plan.sourceOffers[0].taxes = { amountMinor: "5000", currency: "USD", exponent: 2 };
    expect(createTripOption(plan).payment.cashByCurrency).toEqual([plan.sourceOffers[0].totalPrice]);
  });
  it("represents an all-award trip while separating programs and combining like points", () => {
    const plan = splitPlan();
    plan.bookingComponents.forEach((component, i) => {
      component.payment = { kind: "award", program: { id: i === 2 ? "united-mileageplus" : "aeroplan" },
        points: ["55000", "20000", "7500"][i], taxesAndFees: [] };
    });
    const trip = createTripOption(plan);
    expect(trip.payment).toEqual({ cashByCurrency: [], pointsByProgram: [
      { program: { id: "aeroplan" }, points: "75000" }, { program: { id: "united-mileageplus" }, points: "7500" }] });
    expect(trip.warnings).not.toContain("mixed_payment");
    expect(TripOptionSchema.parse(JSON.parse(JSON.stringify(trip)))).toEqual(trip);
  });
  it("represents a genuine single-component cash-and-points quote", () => {
    const plan = singlePlan();
    plan.bookingComponents[0].payment = { kind: "cash_and_points", program: { id: "aeroplan" }, points: "20000",
      cash: [{ amountMinor: "10000", currency: "USD", exponent: 2 }] };
    const trip = createTripOption(plan);
    expect(trip.payment.cashByCurrency[0].amountMinor).toBe("10000");
    expect(trip.payment.pointsByProgram[0].points).toBe("20000");
    expect(trip.warnings).toContain("mixed_payment");
    expect(TripOptionSchema.parse(JSON.parse(JSON.stringify(trip)))).toEqual(trip);
  });
  it.each(["amountMinor", "currency"] as const)("rejects a rewritten source cash %s", (field) => {
    const plan = singlePlan(); plan.bookingComponents[0].payment = { kind: "cash", amount: { ...plan.sourceOffers[0].totalPrice, [field]: field === "currency" ? "EUR" : "1" } };
    invalidPlan(plan);
  });
  it.each(["cash", "award"] as const)("turns aggregate %s overflow into schema issues", (kind) => {
    const plan = splitPlan();
    plan.bookingComponents.forEach((component, i) => {
      if (kind === "cash") { plan.sourceOffers[i].totalPrice.amountMinor = "9".repeat(38); component.payment = { kind, amount: plan.sourceOffers[i].totalPrice }; }
      else component.payment = { kind, points: "9".repeat(38), program: { id: "aeroplan" }, taxesAndFees: [] };
    });
    invalidPlan(plan);
  });
});

describe("connection evidence and structural time", () => {
  it("requires explicit provider evidence for a protected same-booking connection", () => {
    const plan = singlePlan(); plan.protectionFacts = [{ journeyIndex: 0, fromSegmentIndex: 0, protection: "protected", reference: "synthetic-provider-rule-1" }];
    const trip = createTripOption(plan);
    expect(trip.connections[0]).toMatchObject({ protection: "protected", crossesBookingBoundary: false,
      evidence: { kind: "provider", provider: "fixture", providerOfferId: "source-one-offer", reference: "synthetic-provider-rule-1" } });
    expect(trip.connections[1].protection).toBe("unknown");
  });
  it.each(["protected", "self_transfer"] as const)("keeps airport change independent from %s evidence", (protection) => {
    const plan = singlePlan(); plan.sourceOffers[0].journeys[0].segments[1].origin = "HND";
    plan.sourceOffers[0].warnings = ["airport_change"];
    plan.protectionFacts = [{ journeyIndex: 0, fromSegmentIndex: 0, protection, reference: "synthetic-rule" }];
    const trip = createTripOption(plan);
    expect(trip.connections[0]).toMatchObject({ airportChange: true, protection, crossesBookingBoundary: false });
    expect(trip.warnings).toContain("airport_change");
  });
  it("keeps airport change unknown without evidence and preserves source self-transfer disclosures", () => {
    const plan = singlePlan(); plan.sourceOffers[0].journeys[0].segments[1].origin = "HND";
    plan.sourceOffers[0].warnings = ["airport_change", "self_transfer"];
    const trip = createTripOption(plan);
    expect(trip.connections[0].protection).toBe("unknown"); expect(trip.warnings).toContain("self_transfer");
    plan.protectionFacts = [
      { journeyIndex: 0, fromSegmentIndex: 0, protection: "protected", reference: "protected-connection-rule" },
      { journeyIndex: 0, fromSegmentIndex: 1, protection: "self_transfer", reference: "separate-transfer-rule" },
    ];
    const detailed = createTripOption(plan);
    expect(detailed.connections.map((c) => c.protection)).toEqual(["protected", "self_transfer"]);
    expect(detailed.warnings).toContain("self_transfer");
  });
  it.each([0, 30_001, 36 * 3_600_000, 7 * 24 * 3_600_000])("retains an exact %i ms connection without deciding feasibility", (gap) => {
    const plan = splitPlan(); const a = plan.sourceOffers[0].journeys[0].segments[0];
    const b = plan.sourceOffers[1].journeys[0].segments[0]; const c = plan.sourceOffers[2].journeys[0].segments[0];
    b.departureAt = new Date(Date.parse(a.arrivalAt) + gap).toISOString(); b.arrivalAt = new Date(Date.parse(b.departureAt) + 3_600_000).toISOString();
    c.departureAt = new Date(Date.parse(b.arrivalAt) + 3_600_000).toISOString(); c.arrivalAt = new Date(Date.parse(c.departureAt) + 3_600_000).toISOString();
    const trip = createTripOption(plan);
    expect(trip.connections[0].durationMilliseconds).toBe(gap);
    expect(trip.warnings).not.toContain("short_connection"); expect(trip.warnings).not.toContain("long_connection");
  });
  it("compares timestamp instants rather than wall-clock spellings", () => {
    const connection = createTripOption(singlePlan()).connections[0];
    connection.arrivalAt = "2026-10-10T10:00:00+02:00";
    connection.departureAt = "2026-10-10T05:00:00-05:00";
    expect(ConnectionSchema.parse(connection).durationMilliseconds).toBe(7_200_000);
    const plan = singlePlan(); plan.sourceOffers[0].journeys[0].segments[0].arrivalAt = connection.arrivalAt;
    expect(createTripOption(plan).connections[0].arrivalAt).toBe("2026-10-10T08:00:00.000Z");
    expect(plan.sourceOffers[0].journeys[0].segments[0].arrivalAt).toBe(connection.arrivalAt);
  });
  it.each([
    ["durationMilliseconds", -1], ["durationMilliseconds", 1], ["airportChange", true], ["crossesBookingBoundary", true],
    ["departureAt", "2026-10-10T07:00:00Z"], ["protection", "protected"], ["protection", "self_transfer"],
  ])("rejects inconsistent connection %s", (field, value) => {
    const c = { ...createTripOption(singlePlan()).connections[0], [field]: value };
    expect(ConnectionSchema.safeParse(c).success).toBe(false);
  });
  it("rejects manufactured protection across independent bookings", () => {
    const plan = splitPlan(); plan.protectionFacts = [{ journeyIndex: 0, fromSegmentIndex: 0, protection: "protected", reference: "same-provider-is-not-proof" }]; invalidPlan(plan);
    const c = createTripOption(splitPlan()).connections[0];
    expect(ConnectionSchema.safeParse({ ...c, protection: "protected" }).success).toBe(false);
    expect(ConnectionSchema.safeParse({ ...c, protection: "unknown" }).success).toBe(false);
  });
});

describe("adversarial references and full source coverage", () => {
  const changes: [string, (p: TripPlan) => void][] = [
    ["empty components", p => { p.bookingComponents = [] as unknown as TripPlan["bookingComponents"]; }],
    ["empty journeys", p => { p.journeys = [] as unknown as TripPlan["journeys"]; }],
    ["bad component order", p => { p.bookingComponents[1].order = 0; }],
    ["duplicate component ID", p => { p.bookingComponents[1].id = p.bookingComponents[0].id; }],
    ["missing source", p => { p.bookingComponents[0].sourceOfferIndex = 100; }],
    ["reused snapshot", p => { p.bookingComponents[1].sourceOfferIndex = 0; }],
    ["unselected snapshot", p => { p.sourceOffers.push(structuredClone(p.sourceOffers[0])); }],
    ["provider mismatch", p => { p.bookingComponents[0].provider = "different"; }],
    ["source offer mismatch", p => { p.bookingComponents[0].providerOfferId = "different"; }],
    ["observation mismatch", p => { p.bookingComponents[0].offerId = "different"; }],
    ["missing component ref", p => { p.journeys[0].segments[0].componentIndex = 100; }],
    ["missing journey ref", p => { p.journeys[0].segments[0].journeyIndex = 100; }],
    ["missing segment ref", p => { p.journeys[0].segments[0].segmentIndex = 100; }],
    ["unused component", p => { p.journeys[0].segments.pop(); p.journeys[0].requestedDestination = "LAX"; }],
    ["duplicate segment", p => { p.journeys[0].segments.push(structuredClone(p.journeys[0].segments[2])); }],
    ["backward travel", p => { p.journeys[0].segments.reverse(); }],
    ["wrong origin", p => { p.journeys[0].requestedOrigin = "ARN"; }],
    ["wrong destination", p => { p.journeys[0].requestedDestination = "SEA"; }],
    ["overlap", p => { p.sourceOffers[1].journeys[0].segments[0].departureAt = "2026-10-10T07:00:00Z"; }],
    ["invented identity", p => { p.sourceOffers[0].journeys[0].segments[0].operatingFlightNumber = null; }],
    ["nonexistent connection fact", p => { p.protectionFacts.push({ journeyIndex: 99, fromSegmentIndex: 0, protection: "protected", reference: "x" }); }],
  ];
  it.each(changes)("rejects %s", (_, mutate) => { const plan = splitPlan(); mutate(plan); invalidPlan(plan); });
  it("forbids exiting at SFO while omitting a booked onward SEA segment", () => {
    const plan = singlePlan(); const tail = { ...tripSegments()[2], origin: "SFO", destination: "SEA", departureAt: "2026-10-11T02:00:00Z", arrivalAt: "2026-10-11T04:00:00Z" };
    plan.sourceOffers[0].journeys[0].segments.push(tail);
    invalidPlan(plan);
  });
  it("rejects splitting or merging source journey boundaries to hide obligations", () => {
    const merged = roundTripPlan(); merged.journeys[0].segments.push(...merged.journeys[1].segments); merged.journeys.pop(); merged.journeys[0].requestedDestination = "ARN"; invalidPlan(merged);
    const split = singlePlan(); const tail = split.journeys[0].segments.splice(1);
    split.journeys[0].requestedDestination = "NRT";
    split.journeys.push({ requestedOrigin: "NRT", requestedDestination: "SFO", segments: tail as TripPlan["journeys"][0]["segments"] }); invalidPlan(split);
    const omitted = roundTripPlan(); omitted.journeys.pop(); invalidPlan(omitted);
  });
  it("rejects chronology violations across explicit journey boundaries too", () => {
    const plan = roundTripPlan();
    for (const s of plan.sourceOffers[0].journeys[1].segments) { s.departureAt = s.departureAt.replace("10-20", "10-01"); s.arrivalAt = s.arrivalAt.replace("10-20", "10-01"); }
    expect(FlightOfferSchema.safeParse(plan.sourceOffers[0]).success).toBe(true); invalidPlan(plan);
  });
  it("rejects duplicate connection evidence", () => {
    const plan = singlePlan(); const fact = { journeyIndex: 0, fromSegmentIndex: 0, protection: "protected" as const, reference: "rule" };
    plan.protectionFacts = [fact, fact]; invalidPlan(plan);
  });
  it.each([undefined, 1n, NaN, Infinity, new Date(), () => 1])("rejects non-JSON source metadata %s", (value) => {
    const plan = singlePlan(); plan.sourceOffers[0].providerMetadata = { value }; invalidPlan(plan);
  });
  it("rejects cyclic metadata without throwing from safeParse", () => {
    const plan = singlePlan(); const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    plan.sourceOffers[0].providerMetadata = cycle; invalidPlan(plan);
  });
});

describe("canonical output integrity", () => {
  const tamper: [string, (t: TripOption) => void][] = [
    ["cash total", t => { t.payment.cashByCurrency[0].amountMinor = "1"; }],
    ["invented points", t => { t.payment.pointsByProgram.push({ program: { id: "aeroplan" }, points: "1" }); }],
    ["travel duration", t => { t.travel.durationMilliseconds++; }],
    ["journey duration", t => { t.travel.journeys[0].durationMilliseconds++; }],
    ["count", t => { t.travel.segmentCount++; }],
    ["component count", t => { t.travel.bookingComponentCount++; }],
    ["arrival", t => { t.travel.finalArrivalAt = "2026-10-12T00:00:00Z"; }],
    ["missing connection", t => { t.connections.pop(); }],
    ["duplicate connection", t => { t.connections.push(t.connections[0]); }],
    ["connection order", t => { t.connections.reverse(); }],
    ["missing warnings", t => { t.warnings = []; }],
    ["invented warnings", t => { t.warnings.push("mixed_payment"); }],
    ["duplicate warnings", t => { t.warnings.push(t.warnings[0]); }],
  ];
  it.each(tamper)("rejects tampered %s", (_, mutate) => {
    const trip = createTripOption(splitPlan()); mutate(trip);
    expect(() => TripOptionSchema.safeParse(trip)).not.toThrow(); expect(TripOptionSchema.safeParse(trip).success).toBe(false);
  });
  it("rejects falsified provider attribution on connection evidence", () => {
    const plan = singlePlan(); plan.protectionFacts = [{ journeyIndex: 0, fromSegmentIndex: 0, protection: "protected", reference: "rule" }];
    const trip = createTripOption(plan);
    if (trip.connections[0].evidence.kind !== "provider") throw Error("fixture");
    trip.connections[0].evidence.provider = "another-provider";
    expect(TripOptionSchema.safeParse(trip).success).toBe(false);
  });
  it.each([singlePlan, splitPlan, roundTripPlan])("round-trips all trip data and leaves frozen plans unchanged", (factory) => {
    const plan = factory(); const before = structuredClone(plan); freezeDeep(plan);
    const trip = createTripOption(plan);
    expect(TripOptionSchema.parse(JSON.parse(JSON.stringify(trip)))).toEqual(trip);
    expect(plan).toEqual(before);
    trip.sourceOffers[0].journeys[0].segments[0].destination = "SEA";
    expect(plan).toEqual(before);
  });
  it("keeps component references strict and rejects ticket/valuation fields", () => {
    const component = splitPlan().bookingComponents[0];
    for (const extra of [{ ticketNumber: "issued" }, { offer: splitPlan().sourceOffers[0] }, { effectiveCost: 50 }]) {
      expect(BookingComponentSchema.safeParse({ ...component, ...extra }).success).toBe(false);
    }
    const trip = createTripOption(singlePlan());
    expect(TripOptionSchema.safeParse({ ...trip, effectiveCost: 50 }).success).toBe(false);
    expect(TripOptionSchema.safeParse({ ...trip, travel: { ...trip.travel, routesFeasible: true } }).success).toBe(false);
  });
  it("excludes nested source metadata and isolates projected fields from the source", () => {
    const plan = singlePlan();
    plan.sourceOffers[0].providerMetadata = { native: { fareCode: "synthetic" } };
    const before = structuredClone(plan);
    const trip = createTripOption(plan);
    expect(trip.sourceOffers[0]).not.toHaveProperty("providerMetadata");
    trip.sourceOffers[0].journeys[0].segments[0].destination = "SEA";
    trip.sourceOffers[0].totalPrice.amountMinor = "1";
    expect(plan).toEqual(before);
  });
  it.each(["amountMinor", "points"] as const)("reports malformed nested %s without an arithmetic exception", (field) => {
    const trip = createTripOption(singlePlan());
    const payment = field === "points"
      ? { kind: "award", program: { id: "aeroplan" }, points: "not-an-integer", taxesAndFees: [] }
      : { kind: "cash", amount: { amountMinor: "not-an-integer", currency: "USD", exponent: 2 } };
    const raw = { ...trip, bookingComponents: [{ ...trip.bookingComponents[0], payment }] };
    expect(() => TripOptionSchema.safeParse(raw)).not.toThrow();
    expect(TripOptionSchema.safeParse(raw).success).toBe(false);
  });
  it.each(["", "fb:schedule:v2:" + "a".repeat(64), "fb:schedule:v1:" + "a".repeat(63), "fb:schedule:v1:" + "A".repeat(64), "fb:schedule:v1:" + "a".repeat(64) + "\n"])(
    "rejects malformed schedule reference %s", (scheduleFingerprint) => expect(BookingComponentSchema.safeParse({ ...singlePlan().bookingComponents[0], scheduleFingerprint }).success).toBe(false),
  );
  it("preserves the original C002 golden round-trip fingerprint and all source facts", () => {
    const plan = roundTripPlan(); const before = structuredClone(plan.sourceOffers);
    const trip = createTripOption(plan);
    expect(itineraryFingerprint(FlightOfferSchema.parse(trip.sourceOffers[0]))).toBe("fb:schedule:v1:f4e25b498ad038db5cbb6ff5bce300508f95f2862868f91e7663ce866a32a76a");
    expect(trip.sourceOffers).toEqual(before.map(({ providerMetadata, ...snapshot }) => snapshot));
    expect(plan.sourceOffers).toEqual(before);
  });
});
