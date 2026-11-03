/**
 * Tests for points-aware (miles) ranking — Goal item 13.
 *
 * Covers:
 *  - Within-program ranking by points-then-cash (points dominates cash)
 *  - NO cross-program comparison (two programs → points_incomparable_across_programs, no lowest_points_cost)
 *  - NO points↔cash (cash+award mixed → points_incomparable_with_cash on award, cash still gets lowest_cash_price)
 *  - NO blended score (points don't change displayScore)
 *  - Integer points only (PointsAmountSchema rejects decimals/negatives; comparePoints exact on 38-digit value)
 *  - Deterministic/no wall clock
 *  - Reasons closed-enum canonical-order
 *  - Award PROVENANCE enforced (when awardPrice present on source)
 *  - Import isolation (ranking imports only domain+zod)
 *  - Back-compat (all metrics have pointsComparableKey)
 *  - Transitivity guard (mixed-program set is permutation-invariant)
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createTripOption,
  PointsAmountSchema,
  comparePoints,
  TripOptionSchema,
  type FlightOffer,
  type TripPlan,
  type TripOption,
} from "@flightbrain/domain";
import {
  compareTripOptions,
  rankTripOptions,
  TripRankReasonSchema,
  TripRankingPolicySchema,
  TripRankMetricsSchema,
  RankedTripOptionSchema,
  type TripRankingPolicy,
} from "@flightbrain/ranking";
import { planFor, tripSegments } from "./fixtures/trips";

const BASE_POLICY: TripRankingPolicy = TripRankingPolicySchema.parse({ asOf: "2026-10-09T00:00:00Z" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal award TripOption with awardPrice on the source offer. */
function makeAwardTrip(opts: {
  id: string;
  programId: string;
  points: string;
  taxesAndFees?: Array<{ amountMinor: string; currency: "USD"; exponent: 2 }>;
  durationMs?: number;
}): TripOption {
  const { id, programId, points, taxesAndFees = [], durationMs = 8 * 3_600_000 } = opts;
  const segs = tripSegments();
  const departureAt = "2026-10-10T00:00:00Z";
  const arrivalAt = new Date(Date.parse(departureAt) + durationMs).toISOString();
  const seg0 = { ...segs[0], destination: "SFO", departureAt, arrivalAt };

  const sourceOffer: FlightOffer = {
    id,
    provider: "mock",
    providerOfferId: `source-${id}`,
    journeys: [{ segments: [seg0] }],
    // totalPrice carries cash component (or zero if none)
    totalPrice: taxesAndFees.length > 0
      ? taxesAndFees[0]
      : { amountMinor: "0", currency: "USD", exponent: 2 },
    refundable: null,
    changeable: null,
    checkedBags: null,
    cabinBags: null,
    bookingUrl: null,
    retrievedAt: "2026-09-17T00:00:00Z",
    expiresAt: null,
    requiresRevalidation: false,
    warnings: [],
    providerMetadata: {},
    awardPrice: {
      program: { id: programId },
      points,
      cashComponent: taxesAndFees,
    },
  };

  const payment = {
    kind: "award" as const,
    program: { id: programId },
    points,
    taxesAndFees,
  };

  const plan: TripPlan = planFor([sourceOffer], [payment]);
  plan.id = id;
  return createTripOption(plan);
}

/** Build a minimal cash TripOption. */
function makeCashTrip(opts: {
  id: string;
  amountMinor: string;
  currency?: "USD" | "EUR";
  durationMs?: number;
}): TripOption {
  const { id, amountMinor, currency = "USD", durationMs = 8 * 3_600_000 } = opts;
  const segs = tripSegments();
  const departureAt = "2026-10-10T00:00:00Z";
  const arrivalAt = new Date(Date.parse(departureAt) + durationMs).toISOString();
  const seg0 = { ...segs[0], destination: "SFO", departureAt, arrivalAt };
  const exponent = currency === "USD" ? 2 : 2;

  const sourceOffer: FlightOffer = {
    id,
    provider: "mock",
    providerOfferId: `source-${id}`,
    journeys: [{ segments: [seg0] }],
    totalPrice: { amountMinor, currency, exponent },
    refundable: null,
    changeable: null,
    checkedBags: null,
    cabinBags: null,
    bookingUrl: null,
    retrievedAt: "2026-09-17T00:00:00Z",
    expiresAt: null,
    requiresRevalidation: false,
    warnings: [],
    providerMetadata: {},
  };

  const payment = { kind: "cash" as const, amount: { amountMinor, currency, exponent } };
  const plan: TripPlan = planFor([sourceOffer], [payment]);
  plan.id = id;
  return createTripOption(plan);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("points-aware ranking (goal 13)", () => {

  // (1) Within-program: fewer points ranks higher; points dominate cash tiebreak
  it("within one program, fewer points ranks higher (points dominates cash)", () => {
    const cheap = makeAwardTrip({ id: "cheap-pts", programId: "aeroplan", points: "40000" });
    const expensive = makeAwardTrip({ id: "expensive-pts", programId: "aeroplan", points: "60000" });
    const result = rankTripOptions([expensive, cheap], BASE_POLICY);
    expect(result.ranked[0].trip.id).toBe("cheap-pts");
    expect(result.ranked[0].reasons).toContain("lowest_points_cost");
    expect(result.ranked[1].reasons).not.toContain("lowest_points_cost");
  });

  // (2) Within-program: when points equal, cash component (taxes) is secondary tiebreak
  it("within one program, equal points → lower cash taxes ranks higher", () => {
    // IDs are intentionally ordered so that the id tiebreak (ASCII) would put "high-fees" BEFORE
    // "low-fees", which is the WRONG order. Only the cash comparison can produce the correct order.
    const lowFees = makeAwardTrip({
      id: "low-fees", programId: "aeroplan", points: "50000",
      taxesAndFees: [{ amountMinor: "3000", currency: "USD", exponent: 2 }],
    });
    const highFees = makeAwardTrip({
      id: "high-fees", programId: "aeroplan", points: "50000",
      taxesAndFees: [{ amountMinor: "8000", currency: "USD", exponent: 2 }],
    });
    // "high-fees" < "low-fees" alphabetically, so id tiebreak alone would put highFees first.
    // The cash tiebreak (3000 < 8000 USD) must override and place lowFees first.
    const result = rankTripOptions([highFees, lowFees], BASE_POLICY);
    expect(result.ranked[0].trip.id).toBe("low-fees");
  });

  // (3) NO cross-program: two different programs → points_incomparable_across_programs, no lowest_points_cost
  it("two programs → points_incomparable_across_programs, no lowest_points_cost", () => {
    const aeroplan = makeAwardTrip({ id: "aeroplan-trip", programId: "aeroplan", points: "40000" });
    const united = makeAwardTrip({ id: "united-trip", programId: "united-mileageplus", points: "60000" });
    const result = rankTripOptions([aeroplan, united], BASE_POLICY);
    expect(result.diagnostics).toContain("points_incomparable_across_programs");
    // No lowest_points_cost since programs are different
    for (const entry of result.ranked) {
      expect(entry.reasons).not.toContain("lowest_points_cost");
    }
    // Each award trip carries points_incomparable_across_programs reason
    const aeroplanEntry = result.ranked.find((r) => r.trip.id === "aeroplan-trip")!;
    const unitedEntry = result.ranked.find((r) => r.trip.id === "united-trip")!;
    expect(aeroplanEntry.reasons).toContain("points_incomparable_across_programs");
    expect(unitedEntry.reasons).toContain("points_incomparable_across_programs");
  });

  // (4) NO points↔cash: mixed award+cash set → points_incomparable_with_cash on both sides
  it("cash+award mixed → points_incomparable_with_cash on award trip, cash still gets lowest_cash_price", () => {
    const awardTrip = makeAwardTrip({ id: "award-trip", programId: "aeroplan", points: "50000" });
    const cashTrip = makeCashTrip({ id: "cash-trip", amountMinor: "50000" });

    const result = rankTripOptions([awardTrip, cashTrip], BASE_POLICY);
    const awardEntry = result.ranked.find((r) => r.trip.id === "award-trip")!;
    const cashEntry = result.ranked.find((r) => r.trip.id === "cash-trip")!;

    // Award trip gets points_incomparable_with_cash
    expect(awardEntry.reasons).toContain("points_incomparable_with_cash");
    // Cash trip also gets incomparable label (mixed set)
    expect(cashEntry.reasons).toContain("points_incomparable_with_cash");

    // Cash trip is the cheapest by cash price (only cash-comparable entry)
    expect(cashEntry.reasons).toContain("lowest_cash_price");
    // Award trip cannot have lowest_cash_price
    expect(awardEntry.reasons).not.toContain("lowest_cash_price");

    // No blended comparison (no cross-currency FX invented)
    expect(result.diagnostics).toContain("mixed_currency_incomparable");
  });

  // (5) NO blended score: award doesn't change displayScore (adding points doesn't blend)
  it("adding points to a trip does not change its displayScore", () => {
    // Build the same trip twice with identical routing — 50k points vs 100k points.
    // If points bled into displayScore the scores would differ; they must be byte-identical.
    const DURATION_MS = 8 * 3_600_000;
    const fewPoints = makeAwardTrip({ id: "score-few-pts", programId: "aeroplan", points: "50000", durationMs: DURATION_MS });
    const fewResult = rankTripOptions([fewPoints], BASE_POLICY);
    const fewScore = fewResult.ranked[0].displayScore;

    const manyPoints = makeAwardTrip({ id: "score-many-pts", programId: "aeroplan", points: "100000", durationMs: DURATION_MS });
    const manyResult = rankTripOptions([manyPoints], BASE_POLICY);
    const manyScore = manyResult.ranked[0].displayScore;

    // The displayScore must be identical — points are never folded into the score
    expect(fewScore).toBe(manyScore);
    // Also confirm no points-blended props exist
    expect(fewResult.ranked[0].metrics).not.toHaveProperty("pointsScore");
    expect(fewResult.ranked[0]).not.toHaveProperty("combinedValue");
  });

  // (6) Integer points only: PointsAmountSchema rejects decimals and negatives
  it("PointsAmountSchema rejects decimal and negative points", () => {
    expect(PointsAmountSchema.safeParse("50000").success).toBe(true);
    expect(PointsAmountSchema.safeParse("0").success).toBe(true);
    // Reject decimals
    expect(PointsAmountSchema.safeParse("50000.5").success).toBe(false);
    // Reject negatives
    expect(PointsAmountSchema.safeParse("-1").success).toBe(false);
    // Reject empty
    expect(PointsAmountSchema.safeParse("").success).toBe(false);
  });

  // (7) comparePoints is exact on a 38-digit value (BigInt precision)
  it("comparePoints works exactly on a 38-digit value", () => {
    const big = "9".repeat(38);
    const bigMinusOne = "9".repeat(37) + "8";
    expect(comparePoints(bigMinusOne, big)).toBe(-1);
    expect(comparePoints(big, bigMinusOne)).toBe(1);
    expect(comparePoints(big, big)).toBe(0);
  });

  // (8) Deterministic: same inputs → byte-identical results, no wall clock
  it("points ranking is deterministic across repeated calls", () => {
    const a = makeAwardTrip({ id: "det-a", programId: "aeroplan", points: "40000" });
    const b = makeAwardTrip({ id: "det-b", programId: "aeroplan", points: "60000" });
    const r1 = rankTripOptions([a, b], BASE_POLICY);
    const r2 = rankTripOptions([a, b], BASE_POLICY);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  // (9) Reasons are in closed-enum canonical order: new reasons respect REASON_ORDER
  it("new points reasons appear after price_incomparable_currency in canonical order", () => {
    expect(TripRankReasonSchema.options).toContain("lowest_points_cost");
    expect(TripRankReasonSchema.options).toContain("points_incomparable_across_programs");
    expect(TripRankReasonSchema.options).toContain("points_incomparable_with_cash");

    // Canonical order: price reasons appear before points reasons
    const opts = TripRankReasonSchema.options as string[];
    const lowestCashIdx = opts.indexOf("lowest_cash_price");
    const lowestPtsIdx = opts.indexOf("lowest_points_cost");
    const priceCurrencyIdx = opts.indexOf("price_incomparable_currency");
    const ptsAcrossIdx = opts.indexOf("points_incomparable_across_programs");
    const ptsCashIdx = opts.indexOf("points_incomparable_with_cash");

    // lowest_points_cost comes after lowest_cash_price
    expect(lowestPtsIdx).toBeGreaterThan(lowestCashIdx);
    // points_incomparable reasons come after price_incomparable_currency
    expect(ptsAcrossIdx).toBeGreaterThan(priceCurrencyIdx);
    expect(ptsCashIdx).toBeGreaterThan(priceCurrencyIdx);
  });

  // (10) Award PROVENANCE: when awardPrice present, createTripOption rejects mismatched program
  it("createTripOption rejects award payment with wrong program vs awardPrice.program", () => {
    const seg = tripSegments()[0];
    const seg0 = { ...seg, destination: "SFO", departureAt: "2026-10-10T00:00:00Z", arrivalAt: "2026-10-10T08:00:00Z" };

    const sourceOffer: FlightOffer = {
      id: "prov-mismatch",
      provider: "mock",
      providerOfferId: "source-prov-mismatch",
      journeys: [{ segments: [seg0] }],
      totalPrice: { amountMinor: "0", currency: "USD", exponent: 2 },
      refundable: null, changeable: null, checkedBags: null, cabinBags: null,
      bookingUrl: null, retrievedAt: "2026-09-17T00:00:00Z", expiresAt: null,
      requiresRevalidation: false, warnings: [], providerMetadata: {},
      awardPrice: { program: { id: "aeroplan" }, points: "50000", cashComponent: [] },
    };

    // Payment uses a DIFFERENT program than awardPrice
    const wrongProgramPayment = {
      kind: "award" as const,
      program: { id: "united-mileageplus" }, // wrong!
      points: "50000",
      taxesAndFees: [],
    };
    const plan = planFor([sourceOffer], [wrongProgramPayment]);
    plan.id = "prov-mismatch-trip";

    expect(() => createTripOption(plan)).toThrow();
  });

  // (11) Award PROVENANCE: when awardPrice present, createTripOption rejects mismatched points
  it("createTripOption rejects award payment with wrong points vs awardPrice.points", () => {
    const seg = tripSegments()[0];
    const seg0 = { ...seg, destination: "SFO", departureAt: "2026-10-10T00:00:00Z", arrivalAt: "2026-10-10T08:00:00Z" };

    const sourceOffer: FlightOffer = {
      id: "prov-pts-mismatch",
      provider: "mock",
      providerOfferId: "source-prov-pts-mismatch",
      journeys: [{ segments: [seg0] }],
      totalPrice: { amountMinor: "0", currency: "USD", exponent: 2 },
      refundable: null, changeable: null, checkedBags: null, cabinBags: null,
      bookingUrl: null, retrievedAt: "2026-09-17T00:00:00Z", expiresAt: null,
      requiresRevalidation: false, warnings: [], providerMetadata: {},
      awardPrice: { program: { id: "aeroplan" }, points: "50000", cashComponent: [] },
    };

    const wrongPointsPayment = {
      kind: "award" as const,
      program: { id: "aeroplan" },
      points: "99999", // wrong! should be 50000
      taxesAndFees: [],
    };
    const plan = planFor([sourceOffer], [wrongPointsPayment]);
    plan.id = "prov-pts-mismatch-trip";

    expect(() => createTripOption(plan)).toThrow();
  });

  // (12) Award PROVENANCE: when awardPrice present, correct match succeeds
  it("createTripOption accepts award payment that exactly matches awardPrice", () => {
    const trip = makeAwardTrip({ id: "prov-ok", programId: "aeroplan", points: "50000" });
    expect(TripOptionSchema.safeParse(trip).success).toBe(true);
  });

  // (13) IMPORT ISOLATION: ranking/src/trips.ts imports only @flightbrain/domain, zod, local ./
  it("ranking trips.ts only imports from @flightbrain/domain, zod, local siblings", () => {
    const src = readFileSync(
      new URL("../packages/ranking/src/trips.ts", import.meta.url).pathname,
      "utf-8",
    );
    const importMatches = [...src.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["']/gm)];
    const sources = importMatches.map((m) => m[1]);
    for (const source of sources) {
      const allowed = source === "zod" || source === "@flightbrain/domain" || source.startsWith("./");
      expect(allowed, `Forbidden import in ranking/trips.ts: ${source}`).toBe(true);
    }
    expect(src).not.toMatch(/@flightbrain\/orchestrator/);
    expect(src).not.toMatch(/@flightbrain\/providers/);
    expect(src).not.toMatch(/node:crypto/);
    expect(src).not.toMatch(/\bfetch\b/);
  });

  // (14) Back-compat: all existing trips (cash-only) get pointsComparableKey = "incomparable"
  it("cash-only trips have pointsComparableKey = 'incomparable'", () => {
    const cashTrip = makeCashTrip({ id: "cash-compat", amountMinor: "50000" });
    const result = rankTripOptions([cashTrip], BASE_POLICY);
    expect(result.ranked[0].metrics.pointsComparableKey).toBe("incomparable");
  });

  // (15) Award-only trip (single program) has correct pointsComparableKey
  it("award trip with single program has pointsComparableKey = 'programId:points'", () => {
    const awardTrip = makeAwardTrip({ id: "pts-key-test", programId: "aeroplan", points: "55000" });
    const result = rankTripOptions([awardTrip], BASE_POLICY);
    expect(result.ranked[0].metrics.pointsComparableKey).toBe("aeroplan:55000");
  });

  // (16) Transitivity guard: mixed-program set under several permutations → identical id order
  it("mixed-program set is permutation-invariant (commonProgram all-or-nothing)", () => {
    const a = makeAwardTrip({ id: "prog-a", programId: "aeroplan", points: "40000" });
    const b = makeAwardTrip({ id: "prog-b", programId: "united-mileageplus", points: "30000" });
    const c = makeAwardTrip({ id: "prog-c", programId: "aeroplan", points: "60000" });

    const r1 = rankTripOptions([a, b, c], BASE_POLICY).ranked.map((r) => r.trip.id);
    const r2 = rankTripOptions([b, c, a], BASE_POLICY).ranked.map((r) => r.trip.id);
    const r3 = rankTripOptions([c, a, b], BASE_POLICY).ranked.map((r) => r.trip.id);
    const r4 = rankTripOptions([b, a, c], BASE_POLICY).ranked.map((r) => r.trip.id);
    expect(r1).toEqual(r2);
    expect(r1).toEqual(r3);
    expect(r1).toEqual(r4);

    // No strict pairwise cycle
    const cmpAB = compareTripOptions(a, b, BASE_POLICY);
    const cmpBC = compareTripOptions(b, c, BASE_POLICY);
    const cmpCA = compareTripOptions(c, a, BASE_POLICY);
    const isCycle = (cmpAB === -1 && cmpBC === -1 && cmpCA === -1) || (cmpAB === 1 && cmpBC === 1 && cmpCA === 1);
    expect(isCycle).toBe(false);
  });

  // (17) Single-program set with multiple award trips → lowest_points_cost only on cheapest
  it("single-program set: lowest_points_cost only on the cheapest trip", () => {
    const t1 = makeAwardTrip({ id: "sp-1", programId: "aeroplan", points: "30000" });
    const t2 = makeAwardTrip({ id: "sp-2", programId: "aeroplan", points: "50000" });
    const t3 = makeAwardTrip({ id: "sp-3", programId: "aeroplan", points: "80000" });
    const result = rankTripOptions([t3, t1, t2], BASE_POLICY);
    expect(result.ranked[0].trip.id).toBe("sp-1");
    expect(result.ranked[0].reasons).toContain("lowest_points_cost");
    expect(result.ranked[1].reasons).not.toContain("lowest_points_cost");
    expect(result.ranked[2].reasons).not.toContain("lowest_points_cost");
  });

  // (18) TripRankMetricsSchema includes pointsComparableKey; schema rejects missing field
  it("TripRankMetricsSchema requires pointsComparableKey", () => {
    const trip = makeCashTrip({ id: "metrics-test", amountMinor: "50000" });
    const result = rankTripOptions([trip], BASE_POLICY);
    const metrics = result.ranked[0].metrics;
    expect(metrics).toHaveProperty("pointsComparableKey");
    expect(typeof metrics.pointsComparableKey).toBe("string");

    // Schema rejects if pointsComparableKey is missing
    const metricsWithout = { ...metrics };
    delete (metricsWithout as Record<string, unknown>).pointsComparableKey;
    expect(TripRankMetricsSchema.safeParse(metricsWithout).success).toBe(false);
  });

  // (19) RankedTripOptionSchema still validates normally with new reasons
  it("RankedTripOption validates with new reasons present", () => {
    const awardTrip = makeAwardTrip({ id: "schema-test", programId: "aeroplan", points: "50000" });
    const cashTrip = makeCashTrip({ id: "schema-cash", amountMinor: "50000" });
    const result = rankTripOptions([awardTrip, cashTrip], BASE_POLICY);
    for (const entry of result.ranked) {
      expect(RankedTripOptionSchema.safeParse(entry).success).toBe(true);
    }
  });

  // (20) No wall clock in trips.ts (also check points code)
  it("trips.ts uses no Date.now, Math.random, or no-arg new Date()", () => {
    const src = readFileSync(
      new URL("../packages/ranking/src/trips.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(src).not.toMatch(/Date\.now\(\)/);
    expect(src).not.toMatch(/Math\.random\(\)/);
    expect(src).not.toMatch(/new\s+Date\s*\(\s*\)/);
  });
});
