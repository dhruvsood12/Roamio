import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FlightOffer, TripOption } from "@flightbrain/domain";
import { createTripOption } from "@flightbrain/domain";
import { paretoFrontier, rankOffers } from "@flightbrain/ranking";
import {
  compareTripOptions,
  rankTripOptions,
  tripParetoFrontier,
  TripRankReasonSchema,
  TripRankingPolicySchema,
  RankedTripOptionSchema,
  TripRankingResultSchema,
  type TripRankingPolicy,
} from "@flightbrain/ranking";
import { planFor, singlePlan, splitPlan, syntheticOffer, tripSegments } from "./fixtures/trips";

function offer(id: string, amountMinor: string, depart: string, arrive: string, extraSegment = false): FlightOffer {
  // Matching identities here are deliberate facts of these synthetic fixtures.
  const segments: FlightOffer["journeys"][number]["segments"] = [
    {
      origin: "ARN",
      destination: extraSegment ? "CPH" : "SAN",
      departureAt: depart,
      arrivalAt: extraSegment ? "2026-10-10T10:00:00+02:00" : arrive,
      marketingCarrier: "SK",
      operatingCarrier: "SK",
      marketingFlightNumber: "100",
      operatingFlightNumber: "100",
      cabin: "economy",
    },
  ];
  if (extraSegment) {
    segments.push({
      origin: "CPH",
      destination: "SAN",
      departureAt: "2026-10-10T12:00:00+02:00",
      arrivalAt: arrive,
      marketingCarrier: "SK",
      operatingCarrier: "SK",
      marketingFlightNumber: "200",
      operatingFlightNumber: "200",
      cabin: "economy",
    });
  }
  return {
    id,
    provider: "mock",
    providerOfferId: id,
    journeys: [{ segments }],
    totalPrice: { amountMinor, currency: "USD", exponent: 2 },
    refundable: null,
    changeable: null,
    checkedBags: null,
    cabinBags: null,
    bookingUrl: null,
    retrievedAt: "2026-09-17T12:00:00+02:00",
    expiresAt: null,
    requiresRevalidation: true,
    warnings: [],
    providerMetadata: {},
  };
}

describe("ranking", () => {
  it("ranks a cheaper and faster offer above a dominated one", () => {
    const a = offer("a", "50000", "2026-10-10T08:00:00+02:00", "2026-10-10T20:00:00-07:00");
    const b = offer("b", "65000", "2026-10-10T08:00:00+02:00", "2026-10-10T22:00:00-07:00", true);
    expect(paretoFrontier([a, b]).map((x) => x.id)).toEqual(["a"]);
    expect(rankOffers([a, b])[0].offer.id).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// Trip ranking helpers
// ---------------------------------------------------------------------------

const BASE_POLICY: TripRankingPolicy = TripRankingPolicySchema.parse({ asOf: "2026-10-09T00:00:00Z" });

/** Build a minimal TripOption with overrideable fields. */
function makeTripOption(overrides: {
  id?: string;
  amountMinor?: string;
  currency?: "USD" | "EUR" | "GBP" | "JPY" | "KWD";
  durationMs?: number;          // overrides travel duration by shifting arrivalAt
  segments?: number;            // number of segments (1 or 2)
  protection?: "protected" | "self_transfer";
  requiresRevalidation?: boolean;
  expiresAt?: string | null;
  retrievedAt?: string;
  points?: { program: string; points: string };
}): TripOption {
  const {
    id = "trip-a",
    amountMinor = "50000",
    currency = "USD",
    durationMs = 8 * 3_600_000,
    segments = 1,
    protection,
    requiresRevalidation = false,
    expiresAt = null,
    retrievedAt = "2026-09-17T00:00:00Z",
    points,
  } = overrides;

  const departureAt = "2026-10-10T00:00:00Z";
  const arrivalAt = new Date(Date.parse(departureAt) + durationMs).toISOString();

  const segs = tripSegments();
  // Single-segment: DEL->SFO directly
  const seg0 = { ...segs[0], destination: segments === 1 ? "SFO" : "NRT", arrivalAt: segments === 1 ? arrivalAt : "2026-10-10T08:00:00Z", departureAt };

  let segList: typeof segs;
  if (segments === 1) {
    segList = [seg0] as unknown as typeof segs;
  } else {
    // Two-segment itinerary: DEL->NRT->SFO
    const legDuration = Math.floor(durationMs / 2);
    const midAt = new Date(Date.parse(departureAt) + legDuration).toISOString();
    const arrAt = new Date(Date.parse(departureAt) + durationMs).toISOString();
    const s0 = { ...segs[0], destination: "NRT", departureAt, arrivalAt: midAt };
    const s1 = { ...segs[1], origin: "NRT", destination: "SFO", departureAt: midAt, arrivalAt: arrAt };
    segList = [s0, s1] as unknown as typeof segs;
  }

  const exponent = currency === "JPY" ? 0 : currency === "KWD" ? 3 : 2;
  const sourceOffer = {
    ...syntheticOffer([segList[0], ...(segments > 1 ? [segList[1]] : [])] as [typeof segList[0], ...typeof segList[0][]], id),
    id,
    providerOfferId: `source-${id}`,
    totalPrice: { amountMinor, currency, exponent },
    requiresRevalidation,
    expiresAt: expiresAt ?? null,
    retrievedAt,
  };

  let payment: Parameters<typeof planFor>[1];
  if (points) {
    payment = [{ kind: "award", program: { id: points.program }, points: points.points, taxesAndFees: [] }];
  }

  const plan = planFor([sourceOffer], payment);
  plan.id = id;

  // Inject protection facts if needed (only for segments > 1, single-booking)
  if (segments > 1 && protection && protection !== "self_transfer") {
    plan.protectionFacts = [{ journeyIndex: 0, fromSegmentIndex: 0, protection, reference: `rule-${id}` }];
  }

  return createTripOption(plan);
}

// ---------------------------------------------------------------------------
// Test suite: TripOption ranking (C003)
// ---------------------------------------------------------------------------

describe("trip ranking — C003", () => {

  // (1) Total order: exactly one of -1/0/1 per pair
  it("produces exactly -1, 0, or 1 for any pair", () => {
    const a = makeTripOption({ id: "alpha", amountMinor: "50000" });
    const b = makeTripOption({ id: "beta", amountMinor: "60000" });
    const cmp = compareTripOptions(a, b, BASE_POLICY);
    expect([-1, 0, 1]).toContain(cmp);
    // total: must be strictly one of the three
    expect(cmp).toBe(-1); // cheaper a ranks above b
  });

  // (2) Ties broken by ascending id
  it("breaks ties by ascending id when all metrics are equal", () => {
    const a = makeTripOption({ id: "alpha" });
    const b = makeTripOption({ id: "beta" });
    // same metrics, different ids
    const cmp = compareTripOptions(a, b, BASE_POLICY);
    expect(cmp).toBe(-1); // "alpha" < "beta"
    const cmpRev = compareTripOptions(b, a, BASE_POLICY);
    expect(cmpRev).toBe(1);
  });

  // (3) Antisymmetric and transitive over a triple
  it("comparator is antisymmetric and transitive", () => {
    const t1 = makeTripOption({ id: "t1", amountMinor: "50000", durationMs: 8 * 3_600_000 });
    const t2 = makeTripOption({ id: "t2", amountMinor: "60000", durationMs: 7 * 3_600_000 });
    const t3 = makeTripOption({ id: "t3", amountMinor: "70000", durationMs: 9 * 3_600_000 });

    const cmp12 = compareTripOptions(t1, t2, BASE_POLICY);
    const cmp21 = compareTripOptions(t2, t1, BASE_POLICY);
    // Antisymmetric: sign(a,b) == -sign(b,a)
    expect(cmp12).toBe(-cmp21 as -1 | 0 | 1);

    // Transitive: if a < b and b < c then a < c
    const cmp23 = compareTripOptions(t2, t3, BASE_POLICY);
    const cmp13 = compareTripOptions(t1, t3, BASE_POLICY);
    if (cmp12 < 0 && cmp23 < 0) expect(cmp13).toBe(-1);
    if (cmp12 > 0 && cmp23 > 0) expect(cmp13).toBe(1);
  });

  // (4) Invariant under input permutation (seeded shuffles → identical id sequence)
  it("produces identical rank order regardless of input permutation", () => {
    const trips = [
      makeTripOption({ id: "p1", amountMinor: "50000", durationMs: 8 * 3_600_000 }),
      makeTripOption({ id: "p2", amountMinor: "60000", durationMs: 7 * 3_600_000 }),
      makeTripOption({ id: "p3", amountMinor: "55000", durationMs: 9 * 3_600_000 }),
    ];
    const result1 = rankTripOptions(trips, BASE_POLICY);
    // Permutation: [2, 0, 1]
    const permuted = [trips[2], trips[0], trips[1]];
    const result2 = rankTripOptions(permuted, BASE_POLICY);
    expect(result1.ranked.map((r) => r.trip.id)).toEqual(result2.ranked.map((r) => r.trip.id));
    // Reverse order
    const reversed = [...trips].reverse();
    const result3 = rankTripOptions(reversed, BASE_POLICY);
    expect(result1.ranked.map((r) => r.trip.id)).toEqual(result3.ranked.map((r) => r.trip.id));
  });

  // (5) Run twice → byte-identical
  it("is deterministic across repeated calls with the same inputs", () => {
    const trips = [
      makeTripOption({ id: "d1", amountMinor: "50000" }),
      makeTripOption({ id: "d2", amountMinor: "60000" }),
    ];
    const r1 = rankTripOptions(trips, BASE_POLICY);
    const r2 = rankTripOptions(trips, BASE_POLICY);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  // (6) Deep-frozen inputs not mutated
  it("does not mutate deep-frozen input trips", () => {
    const trip = makeTripOption({ id: "frozen" });
    const before = JSON.stringify(trip);
    function freezeDeep(val: unknown): void {
      if (val && typeof val === "object") { Object.values(val).forEach(freezeDeep); Object.freeze(val); }
    }
    freezeDeep(trip);
    rankTripOptions([trip], BASE_POLICY);
    expect(JSON.stringify(trip)).toBe(before);
  });

  // (7) Source grep: no Date.now/Math.random/new Date()-no-arg in trips.ts
  it("trips.ts uses no Date.now, Math.random, or no-arg new Date()", () => {
    const src = readFileSync(
      new URL("../packages/ranking/src/trips.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(src).not.toMatch(/Date\.now\(\)/);
    expect(src).not.toMatch(/Math\.random\(\)/);
    // new Date() with no arguments
    expect(src).not.toMatch(/new\s+Date\s*\(\s*\)/);
  });

  // (8) Same asOf → same staleness; advancing asOf past expiresAt flips offer_expired
  it("staleness is governed by injected asOf, not wall clock", () => {
    const expiresAt = "2026-10-10T12:00:00Z";
    const trip = makeTripOption({ id: "stale-check", expiresAt });

    const beforeExpiry: TripRankingPolicy = { asOf: "2026-10-10T11:00:00Z" };
    const afterExpiry: TripRankingPolicy = { asOf: "2026-10-10T13:00:00Z" };

    const r1 = rankTripOptions([trip], beforeExpiry);
    const r2 = rankTripOptions([trip], afterExpiry);

    const r1Reasons = r1.ranked[0].reasons;
    const r2Reasons = r2.ranked[0].reasons;

    expect(r1Reasons).not.toContain("offer_expired");
    expect(r2Reasons).toContain("offer_expired");

    // After expiry ranks worse than before expiry (down-ranks)
    const fresh = makeTripOption({ id: "fresh" });
    const mixedBefore = rankTripOptions([trip, fresh], beforeExpiry);
    const mixedAfter = rankTripOptions([trip, fresh], afterExpiry);

    // Before expiry: stale-check could rank above/below fresh (depends on other metrics)
    // After expiry: stale-check must rank below fresh (stale = down-rank)
    const staleAfterRank = mixedAfter.ranked.findIndex((r) => r.trip.id === "stale-check");
    const freshAfterRank = mixedAfter.ranked.findIndex((r) => r.trip.id === "fresh");
    expect(staleAfterRank).toBeGreaterThan(freshAfterRank);
  });

  // (9) self_transfer ranks below equal-protected; carries contains_self_transfer
  it("self_transfer trips rank below protected-connection trips", () => {
    // splitPlan() creates a 3-component split ticket (self_transfer connections)
    const splitTrip = createTripOption(splitPlan());
    // singlePlan() creates a 3-segment single component (unknown connections)
    const singleTrip = createTripOption(singlePlan());

    // Make a single-component trip that has protected connections
    const segs = tripSegments();
    const protectedPlan = planFor([syntheticOffer(segs, "protected-offer")]);
    protectedPlan.id = "protected-trip";
    protectedPlan.protectionFacts = [
      { journeyIndex: 0, fromSegmentIndex: 0, protection: "protected", reference: "rule-1" },
      { journeyIndex: 0, fromSegmentIndex: 1, protection: "protected", reference: "rule-2" },
    ];
    const protectedTrip = createTripOption(protectedPlan);

    const result = rankTripOptions([splitTrip, protectedTrip], BASE_POLICY);
    const splitRank = result.ranked.findIndex((r) => r.trip.id === splitTrip.id);
    const protRank = result.ranked.findIndex((r) => r.trip.id === "protected-trip");
    expect(splitRank).toBeGreaterThan(protRank); // protected ranks first (lower index = better)

    // self_transfer carries the reason
    const splitEntry = result.ranked.find((r) => r.trip.id === splitTrip.id)!;
    expect(splitEntry.reasons).toContain("contains_self_transfer");
    // never labeled as "fully_protected_connections"
    expect(splitEntry.reasons).not.toContain("fully_protected_connections");
  });

  // (10) unknown protection carries unknown_connection_protection, not promoted over protected
  it("unknown connection protection carries reason and ranks below protected", () => {
    const unknownTrip = createTripOption(singlePlan()); // has unknown connections

    const segs = tripSegments();
    const protectedPlan = planFor([syntheticOffer(segs, "prot-offer")]);
    protectedPlan.id = "prot-trip";
    protectedPlan.protectionFacts = [
      { journeyIndex: 0, fromSegmentIndex: 0, protection: "protected", reference: "r1" },
      { journeyIndex: 0, fromSegmentIndex: 1, protection: "protected", reference: "r2" },
    ];
    const protectedTrip = createTripOption(protectedPlan);

    const result = rankTripOptions([unknownTrip, protectedTrip], BASE_POLICY);
    const unknownEntry = result.ranked.find((r) => r.trip.id === unknownTrip.id)!;
    const protEntry = result.ranked.find((r) => r.trip.id === "prot-trip")!;

    expect(unknownEntry.reasons).toContain("unknown_connection_protection");
    expect(unknownEntry.reasons).not.toContain("fully_protected_connections");
    expect(protEntry.reasons).toContain("fully_protected_connections");

    // Unknown ranks worse than protected
    const unknownRank = result.ranked.findIndex((r) => r.trip.id === unknownTrip.id);
    const protRank = result.ranked.findIndex((r) => r.trip.id === "prot-trip");
    expect(unknownRank).toBeGreaterThan(protRank);
  });

  // (11) requiresRevalidation/expired down-ranks but stays present (never discarded)
  it("stale trips are present in results but down-ranked", () => {
    const staleTrip = makeTripOption({ id: "stale", requiresRevalidation: true });
    const freshTrip = makeTripOption({ id: "fresh" });

    const result = rankTripOptions([staleTrip, freshTrip], BASE_POLICY);
    expect(result.ranked).toHaveLength(2);
    const staleEntry = result.ranked.find((r) => r.trip.id === "stale")!;
    expect(staleEntry).toBeDefined();
    expect(staleEntry.reasons).toContain("requires_revalidation");

    // fresh ranks before stale
    const staleRank = result.ranked.findIndex((r) => r.trip.id === "stale");
    const freshRank = result.ranked.findIndex((r) => r.trip.id === "fresh");
    expect(freshRank).toBeLessThan(staleRank);
  });

  // (12) NO confidence key/field
  it("ranked results do not contain a confidence field", () => {
    const result = rankTripOptions([makeTripOption({ id: "x" })], BASE_POLICY);
    const entry = result.ranked[0];
    expect(entry).not.toHaveProperty("confidence");
    expect(entry.metrics).not.toHaveProperty("confidence");
    // Also verify via schema parse that confidence is not a valid key
    const withConf = { ...entry, confidence: 0.9 };
    expect(RankedTripOptionSchema.safeParse(withConf).success).toBe(false);
  });

  // (13) Reasons closed enum in canonical order without dupes; out-of-order safeParse fails
  it("reasons are a closed enum in canonical order; out-of-order is rejected", () => {
    const validReasons = ["fastest_itinerary", "offer_expired"];
    expect(TripRankReasonSchema.options).toBeDefined();
    // The schema rejects unknown reason values
    expect(TripRankReasonSchema.safeParse("ai_score").success).toBe(false);
    expect(TripRankReasonSchema.safeParse("confidence").success).toBe(false);
    expect(TripRankReasonSchema.safeParse("lowest_cash_price").success).toBe(true);

    // Out-of-order reasons array fails validation on RankedTripOption
    const trip = makeTripOption({ id: "reasons-order" });
    const result = rankTripOptions([trip], BASE_POLICY);
    const entry = result.ranked[0];
    // Build an entry with reasons in wrong order (swap first two)
    if (entry.reasons.length >= 2) {
      const swapped = [...entry.reasons];
      [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
      const tampered = { ...entry, reasons: swapped };
      expect(RankedTripOptionSchema.safeParse(tampered).success).toBe(false);
    }
    // Validate valid reasons
    for (const r of validReasons) {
      expect(TripRankReasonSchema.safeParse(r).success).toBe(true);
    }
  });

  // (14) Same-currency cheaper ranks higher with lowest_cash_price via compareMoney
  it("same-currency cheaper trip ranks first and carries lowest_cash_price reason", () => {
    const cheap = makeTripOption({ id: "cheap", amountMinor: "40000" });
    const expensive = makeTripOption({ id: "expensive", amountMinor: "80000" });
    const result = rankTripOptions([expensive, cheap], BASE_POLICY);
    expect(result.ranked[0].trip.id).toBe("cheap");
    expect(result.ranked[0].reasons).toContain("lowest_cash_price");
    expect(result.ranked[1].reasons).not.toContain("lowest_cash_price");
  });

  // (15) Different-currency = price-incomparable: price doesn't decide, reason emitted, no FX
  it("different-currency trips are price-incomparable: no FX invented, reason emitted", () => {
    const usdTrip = makeTripOption({ id: "usd-trip", amountMinor: "50000", currency: "USD" });
    const eurTrip = makeTripOption({ id: "eur-trip", amountMinor: "45000", currency: "EUR" });

    // price comparison must NOT throw (no FX)
    expect(() => compareTripOptions(usdTrip, eurTrip, BASE_POLICY)).not.toThrow();
    const cmp = compareTripOptions(usdTrip, eurTrip, BASE_POLICY);
    // Falls through to other dimensions; result should be based on id (same other metrics)
    expect([-1, 0, 1]).toContain(cmp);

    const result = rankTripOptions([usdTrip, eurTrip], BASE_POLICY);
    expect(result.diagnostics).toContain("mixed_currency_incomparable");

    // Each trip with incomparable currency should carry the price_incomparable_currency reason
    const usdEntry = result.ranked.find((r) => r.trip.id === "usd-trip")!;
    const eurEntry = result.ranked.find((r) => r.trip.id === "eur-trip")!;
    expect(usdEntry.reasons).toContain("price_incomparable_currency");
    expect(eurEntry.reasons).toContain("price_incomparable_currency");
  });

  // (16) Award/cash_and_points not falsely ordered by fabricated cash-equiv
  it("award trips are not ranked by invented cash equivalent", () => {
    // Build an award trip
    const awardPlan = singlePlan();
    awardPlan.id = "award-trip";
    awardPlan.bookingComponents[0].payment = {
      kind: "award", program: { id: "aeroplan" }, points: "55000", taxesAndFees: [],
    };
    const awardTrip = createTripOption(awardPlan);

    const cashTrip = makeTripOption({ id: "cash-trip", amountMinor: "50000" });

    // Should not throw; no FX invented
    expect(() => rankTripOptions([awardTrip, cashTrip], BASE_POLICY)).not.toThrow();
    const result = rankTripOptions([awardTrip, cashTrip], BASE_POLICY);
    expect(result.diagnostics).toContain("mixed_currency_incomparable");
    // award trip is still present
    expect(result.ranked.map((r) => r.trip.id)).toContain("award-trip");
  });

  // (17) Every reason maps to a concrete field
  it("fastest_itinerary maps to minimum duration; fully_protected_connections to all-protected; single_booking_component to bookingComponentCount===1", () => {
    // fastest_itinerary
    const fast = makeTripOption({ id: "fast-trip", durationMs: 6 * 3_600_000 });
    const slow = makeTripOption({ id: "slow-trip", durationMs: 12 * 3_600_000 });
    const result = rankTripOptions([fast, slow], BASE_POLICY);
    const fastEntry = result.ranked.find((r) => r.trip.id === "fast-trip")!;
    expect(fastEntry.reasons).toContain("fastest_itinerary");
    expect(fastEntry.trip.travel.durationMilliseconds).toBe(6 * 3_600_000);

    // fully_protected_connections
    const segs = tripSegments();
    const protPlan = planFor([syntheticOffer(segs, "prot2-offer")]);
    protPlan.id = "prot2-trip";
    protPlan.protectionFacts = [
      { journeyIndex: 0, fromSegmentIndex: 0, protection: "protected", reference: "r1" },
      { journeyIndex: 0, fromSegmentIndex: 1, protection: "protected", reference: "r2" },
    ];
    const protTrip = createTripOption(protPlan);
    const singleResult = rankTripOptions([protTrip], BASE_POLICY);
    const protEntry = singleResult.ranked[0];
    expect(protEntry.reasons).toContain("fully_protected_connections");
    expect(protTrip.connections.every((c) => c.protection === "protected")).toBe(true);

    // single_booking_component
    const singleTrip = makeTripOption({ id: "single-booking" });
    const singleBcResult = rankTripOptions([singleTrip], BASE_POLICY);
    const singleEntry = singleBcResult.ranked[0];
    expect(singleEntry.reasons).toContain("single_booking_component");
    expect(singleEntry.trip.travel.bookingComponentCount).toBe(1);
  });

  // (18) IMPORT-ISOLATION: trips.ts imports only from @flightbrain/domain, zod, local ./
  it("trips.ts only imports from @flightbrain/domain, zod, and local siblings", () => {
    const src = readFileSync(
      new URL("../packages/ranking/src/trips.ts", import.meta.url).pathname,
      "utf-8",
    );
    // Extract all import sources
    const importMatches = [...src.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["']/gm)];
    const sources = importMatches.map((m) => m[1]);
    for (const source of sources) {
      const allowed =
        source === "zod" ||
        source === "@flightbrain/domain" ||
        source.startsWith("./");
      expect(allowed, `Forbidden import in trips.ts: ${source}`).toBe(true);
    }
    // Explicit forbidden checks
    expect(src).not.toMatch(/@flightbrain\/orchestrator/);
    expect(src).not.toMatch(/@flightbrain\/providers/);
    expect(src).not.toMatch(/node:crypto/);
    expect(src).not.toMatch(/createHash/);
    expect(src).not.toMatch(/\bfetch\b/);
  });

  // (19) createTripOption output is directly rankable
  it("createTripOption output is directly rankable without pre-processing", () => {
    const trip = createTripOption(singlePlan());
    expect(() => rankTripOptions([trip], BASE_POLICY)).not.toThrow();
    const result = rankTripOptions([trip], BASE_POLICY);
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0].trip.id).toBe(trip.id);
    // Verify full metrics and reasons present
    expect(result.ranked[0].metrics).toBeDefined();
    expect(Array.isArray(result.ranked[0].reasons)).toBe(true);
  });

  // (20) Empty input → empty result; single input → single ranked element with full metrics/reasons
  it("empty input returns empty result; single input returns full ranked element", () => {
    const emptyResult = rankTripOptions([], BASE_POLICY);
    expect(TripRankingResultSchema.safeParse(emptyResult).success).toBe(true);
    expect(emptyResult.ranked).toHaveLength(0);
    expect(emptyResult.diagnostics).toHaveLength(0);

    const singleTrip = makeTripOption({ id: "solo" });
    const singleResult = rankTripOptions([singleTrip], BASE_POLICY);
    expect(TripRankingResultSchema.safeParse(singleResult).success).toBe(true);
    expect(singleResult.ranked).toHaveLength(1);
    expect(singleResult.ranked[0].rank).toBe(0);
    expect(singleResult.ranked[0].metrics).toBeDefined();
    expect(singleResult.ranked[0].reasons).toBeDefined();
    expect(singleResult.ranked[0].displayScore).toBeTypeOf("number");
  });

  // (21) Mixed-currency 3-cycle regression: permutation-invariant ordering & no strict cycle
  //
  // Concrete counterexample the adversarial reviewer identified:
  //   X = USD 90000, id "a"
  //   Y = USD 10000, id "z"
  //   M = EUR 5000,  id "m"
  //   asOf 2026-10-09, all other metrics equal
  //
  // OLD (broken) comparator produced a strict 3-cycle: Y≻X, M≻Y, X≻M — making
  // rankTripOptions permutation-variant. The fix: when the set spans more than one
  // cash currency, price is dropped as a ranking dimension entirely.
  it("mixed-currency set is permutation-invariant and has no pairwise strict cycle", () => {
    const policy: TripRankingPolicy = TripRankingPolicySchema.parse({ asOf: "2026-10-09T00:00:00Z" });

    // Equal on all dimensions except price (which must be ignored) and id (tiebreak).
    const X = makeTripOption({ id: "a", amountMinor: "90000", currency: "USD" });
    const Y = makeTripOption({ id: "z", amountMinor: "10000", currency: "USD" });
    const M = makeTripOption({ id: "m", amountMinor: "5000",  currency: "EUR" });

    // Permutation invariance: multiple input orderings must yield the same ranked id sequence.
    const r1 = rankTripOptions([X, Y, M], policy).ranked.map((r) => r.trip.id);
    const r2 = rankTripOptions([M, Y, X], policy).ranked.map((r) => r.trip.id);
    const r3 = rankTripOptions([Y, M, X], policy).ranked.map((r) => r.trip.id);
    const r4 = rankTripOptions([M, X, Y], policy).ranked.map((r) => r.trip.id);
    expect(r1).toEqual(r2);
    expect(r1).toEqual(r3);
    expect(r1).toEqual(r4);

    // No strict pairwise cycle: if cmp(A,B) < 0 and cmp(B,C) < 0 then cmp(A,C) < 0 (transitivity).
    const cmpXY = compareTripOptions(X, Y, policy);
    const cmpYM = compareTripOptions(Y, M, policy);
    const cmpMX = compareTripOptions(M, X, policy);
    // A strict 3-cycle would have all three return -1 in some rotation; assert that does not happen.
    const isCycle =
      (cmpXY === -1 && cmpYM === -1 && cmpMX === -1) ||
      (cmpXY === 1  && cmpYM === 1  && cmpMX === 1);
    expect(isCycle).toBe(false);

    // Transitivity check for the three pairs:
    // If A < B and B < C then A < C must hold.
    const trips3 = [X, Y, M];
    const ids = ["a", "z", "m"];
    for (let i = 0; i < trips3.length; i++) {
      for (let j = 0; j < trips3.length; j++) {
        for (let k = 0; k < trips3.length; k++) {
          if (i === j || j === k || i === k) continue;
          const ab = compareTripOptions(trips3[i], trips3[j], policy);
          const bc = compareTripOptions(trips3[j], trips3[k], policy);
          const ac = compareTripOptions(trips3[i], trips3[k], policy);
          if (ab === -1 && bc === -1) {
            expect(ac).toBe(-1);
          }
          if (ab === 1 && bc === 1) {
            expect(ac).toBe(1);
          }
        }
      }
    }

    // mixed_currency_incomparable diagnostic must be surfaced for this set.
    const result = rankTripOptions([X, Y, M], policy);
    expect(result.diagnostics).toContain("mixed_currency_incomparable");

    // Each trip should carry the price_incomparable_currency reason.
    for (const entry of result.ranked) {
      expect(entry.reasons).toContain("price_incomparable_currency");
    }

    void ids; // used implicitly above via trips3 indexing
  });
});
