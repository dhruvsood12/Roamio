/**
 * C003 — TripOption ranking
 *
 * Pure lexicographic total comparator over named component metrics.
 * Determinism never depends on float math; final tie-break is trip id.
 *
 * Allowed imports: @flightbrain/domain, zod, local siblings.
 * Forbidden: orchestrator, providers, crypto, network.
 */
import { z } from "zod";
import {
  compareMoney,
  TimestampSchema,
  TripOptionSchema,
  type TripOption,
} from "@flightbrain/domain";

// ---------------------------------------------------------------------------
// Reason enum (closed; canonical order enforced by superRefine)
// ---------------------------------------------------------------------------

export const TripRankReasonSchema = z.enum([
  "lowest_cash_price",
  "fastest_itinerary",
  "fewest_stops",
  "single_booking_component",
  "fully_protected_connections",
  "contains_self_transfer",
  "unknown_connection_protection",
  "requires_revalidation",
  "offer_expired",
  "price_incomparable_currency",
]);
export type TripRankReason = z.infer<typeof TripRankReasonSchema>;

const REASON_ORDER: readonly TripRankReason[] = [
  "lowest_cash_price",
  "fastest_itinerary",
  "fewest_stops",
  "single_booking_component",
  "fully_protected_connections",
  "contains_self_transfer",
  "unknown_connection_protection",
  "requires_revalidation",
  "offer_expired",
  "price_incomparable_currency",
];

function sortedReasons(reasons: TripRankReason[]): TripRankReason[] {
  const seen = new Set<TripRankReason>();
  const out: TripRankReason[] = [];
  for (const r of REASON_ORDER) {
    if (reasons.includes(r) && !seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export const TripRankingPolicySchema = z.strictObject({
  /** Injected reference instant — callers supply this; the function never reads the wall clock. */
  asOf: TimestampSchema,
  /** When set, price comparison is only attempted for this currency. */
  preferredCurrency: z.enum(["EUR", "GBP", "INR", "JPY", "KWD", "SEK", "USD"]).optional(),
});
export type TripRankingPolicy = z.infer<typeof TripRankingPolicySchema>;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const TripRankMetricsSchema = z.strictObject({
  /** Cash price comparison result key: "comparable" | "incomparable". */
  priceComparableKey: z.string(),
  durationMilliseconds: z.number().int().nonnegative(),
  segmentCount: z.number().int().positive(),
  bookingComponentCount: z.number().int().positive(),
  /** 0 = all protected, 1 = contains unknown, 2 = contains self_transfer */
  worstProtectionRank: z.number().int().min(0).max(2),
  /** 0 = fresh, 1 = requiresRevalidation or expired */
  stalenessRank: z.number().int().min(0).max(1),
  /** Epoch milliseconds of the earliest expiresAt (or null if none set). */
  earliestExpiresAtMs: z.number().int().nullable(),
  /** Epoch milliseconds of the latest retrievedAt (recency tiebreak). */
  latestRetrievedAtMs: z.number().int(),
});
export type TripRankMetrics = z.infer<typeof TripRankMetricsSchema>;

// ---------------------------------------------------------------------------
// RankedTripOption
// ---------------------------------------------------------------------------

const RankedTripOptionReasonsSchema = z.array(TripRankReasonSchema).superRefine(
  (reasons, ctx) => {
    const canonical = sortedReasons(reasons as TripRankReason[]);
    if (JSON.stringify(reasons) !== JSON.stringify(canonical)) {
      ctx.addIssue({ code: "custom", message: "Reasons must appear in stable canonical order without duplicates" });
    }
  },
);

export const RankedTripOptionSchema = z.strictObject({
  rank: z.number().int().nonnegative(),
  trip: TripOptionSchema,
  metrics: TripRankMetricsSchema,
  /** Advisory display score; ordering is defined by comparator, never by this value. */
  displayScore: z.number(),
  reasons: RankedTripOptionReasonsSchema,
});
export type RankedTripOption = z.infer<typeof RankedTripOptionSchema>;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export const TripRankingResultSchema = z.strictObject({
  ranked: z.array(RankedTripOptionSchema),
  diagnostics: z.array(z.string()),
});
export type TripRankingResult = z.infer<typeof TripRankingResultSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maps ProtectionState to a numeric rank (higher = worse). */
export function worstProtection(trip: TripOption): 0 | 1 | 2 {
  let worst: 0 | 1 | 2 = 0;
  for (const conn of trip.connections) {
    if (conn.protection === "self_transfer") return 2;
    if (conn.protection === "unknown" && worst < 1) worst = 1;
  }
  return worst;
}

/** Returns staleness rank and earliest expiresAt ms for a trip, given asOf.
 *  Boundary: expiresAt <= asOf counts as expired (inclusive — intentional). */
export function tripStaleness(trip: TripOption, asOfMs: number): { rank: 0 | 1; earliestExpiresAtMs: number | null } {
  let earliestExpiresAtMs: number | null = null;
  let stale = false;
  for (const src of trip.sourceOffers) {
    if (src.requiresRevalidation) { stale = true; }
    if (src.expiresAt !== null && src.expiresAt !== undefined) {
      const ms = Date.parse(src.expiresAt);
      if (ms <= asOfMs) { stale = true; }
      if (earliestExpiresAtMs === null || ms < earliestExpiresAtMs) { earliestExpiresAtMs = ms; }
    }
  }
  return { rank: stale ? 1 : 0, earliestExpiresAtMs };
}

// ---------------------------------------------------------------------------
// Core metric computation
// ---------------------------------------------------------------------------

export function tripRankMetrics(trip: TripOption, policy: TripRankingPolicy): TripRankMetrics {
  const asOfMs = Date.parse(policy.asOf);
  const staleness = tripStaleness(trip, asOfMs);

  // Price comparable key: "USD:12345" if single currency, "incomparable" otherwise.
  const cashByCurrency = trip.payment.cashByCurrency;
  const hasPoints = trip.payment.pointsByProgram.length > 0;
  const priceComparableKey = (
    cashByCurrency.length === 1 &&
    !hasPoints &&
    (policy.preferredCurrency === undefined || cashByCurrency[0].currency === policy.preferredCurrency)
  )
    ? `${cashByCurrency[0].currency}:${cashByCurrency[0].amountMinor}`
    : "incomparable";

  const latestRetrievedAtMs = trip.sourceOffers.reduce(
    (max, src) => Math.max(max, Date.parse(src.retrievedAt)),
    0,
  );

  return TripRankMetricsSchema.parse({
    priceComparableKey,
    durationMilliseconds: trip.travel.durationMilliseconds,
    segmentCount: trip.travel.segmentCount,
    bookingComponentCount: trip.travel.bookingComponentCount,
    worstProtectionRank: worstProtection(trip),
    stalenessRank: staleness.rank,
    earliestExpiresAtMs: staleness.earliestExpiresAtMs,
    latestRetrievedAtMs,
  });
}

// ---------------------------------------------------------------------------
// Total comparator
// ---------------------------------------------------------------------------

/**
 * Total order comparator over TripOptions.
 * - Returns -1 if a ranks better than b, 1 if b ranks better than a, 0 only for identical id.
 * - Antisymmetric, transitive, and deterministic (final tie-break: ascending id).
 *
 * `commonCurrency`: when non-null, ALL trips in the set share this single cash currency,
 * so price comparison is applied globally (produces a consistent total order).
 * When null (mixed currencies), price is dropped entirely as a ranking dimension to
 * preserve transitivity — the id tiebreak then resolves all otherwise-equal pairs.
 */
export function compareTripOptions(
  a: TripOption,
  b: TripOption,
  policy: TripRankingPolicy,
  commonCurrency: string | null = null,
): -1 | 0 | 1 {
  const ma = tripRankMetrics(a, policy);
  const mb = tripRankMetrics(b, policy);

  // 1. Price: only when the ENTIRE set shares a single common cash currency (passed in
  //    by the caller who has set-wide knowledge). Per-pair currency checks are NOT used
  //    here because mixing partial same-currency ordering with a global id tiebreak
  //    produces intransitivity (3-cycles).
  if (commonCurrency !== null) {
    const aComparable = ma.priceComparableKey !== "incomparable";
    const bComparable = mb.priceComparableKey !== "incomparable";
    if (aComparable && bComparable) {
      const cmp = compareMoney(a.payment.cashByCurrency[0], b.payment.cashByCurrency[0]);
      if (cmp !== 0) return cmp as -1 | 1;
    }
  }
  // When commonCurrency is null (mixed-currency set) price is skipped entirely.

  // 2. Duration (shorter is better)
  if (ma.durationMilliseconds < mb.durationMilliseconds) return -1;
  if (ma.durationMilliseconds > mb.durationMilliseconds) return 1;

  // 3. Segment count (fewer stops is better)
  if (ma.segmentCount < mb.segmentCount) return -1;
  if (ma.segmentCount > mb.segmentCount) return 1;

  // 4. Booking component count (fewer is better)
  if (ma.bookingComponentCount < mb.bookingComponentCount) return -1;
  if (ma.bookingComponentCount > mb.bookingComponentCount) return 1;

  // 5. Protection class (lower rank = better)
  if (ma.worstProtectionRank < mb.worstProtectionRank) return -1;
  if (ma.worstProtectionRank > mb.worstProtectionRank) return 1;

  // 6. Staleness (fresher is better)
  if (ma.stalenessRank < mb.stalenessRank) return -1;
  if (ma.stalenessRank > mb.stalenessRank) return 1;

  // 7. Deterministic id tie-break (ascending ASCII order — total)
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Reasons derivation
// ---------------------------------------------------------------------------

export function tripReasons(
  trip: TripOption,
  metrics: TripRankMetrics,
  policy: TripRankingPolicy,
  context: {
    isCheapest: boolean;
    isFastest: boolean;
    isFewestStops: boolean;
    hasPriceIncomparableCurrency: boolean;
  },
): TripRankReason[] {
  const reasons: TripRankReason[] = [];

  if (context.isCheapest && metrics.priceComparableKey !== "incomparable") {
    reasons.push("lowest_cash_price");
  }
  if (context.isFastest) reasons.push("fastest_itinerary");
  if (context.isFewestStops) reasons.push("fewest_stops");
  if (metrics.bookingComponentCount === 1) reasons.push("single_booking_component");

  const protection = worstProtection(trip);
  if (protection === 0 && trip.connections.length > 0) reasons.push("fully_protected_connections");
  if (protection === 2) reasons.push("contains_self_transfer");
  if (protection === 1) reasons.push("unknown_connection_protection");

  const asOfMs = Date.parse(policy.asOf);
  for (const src of trip.sourceOffers) {
    if (src.requiresRevalidation) { reasons.push("requires_revalidation"); break; }
  }
  for (const src of trip.sourceOffers) {
    if (src.expiresAt !== null && src.expiresAt !== undefined && Date.parse(src.expiresAt) <= asOfMs) {
      reasons.push("offer_expired"); break;
    }
  }
  if (context.hasPriceIncomparableCurrency) {
    reasons.push("price_incomparable_currency");
  }

  return sortedReasons(reasons);
}

// ---------------------------------------------------------------------------
// Pareto frontier (honest dominance)
// ---------------------------------------------------------------------------

/**
 * Returns trips that are not strictly dominated by any other trip.
 * Incomparable price (different currencies / points present) means price dimension
 * cannot contribute to dominance, so the trip is retained.
 */
export function tripParetoFrontier(trips: TripOption[], policy: TripRankingPolicy): TripOption[] {
  const pairs = trips.map((trip) => ({ trip, metrics: tripRankMetrics(trip, policy) }));
  return pairs
    .filter((candidate, i) => !pairs.some((other, j) => {
      if (j === i) return false;
      return dominatesTrip(other.trip, other.metrics, candidate.trip, candidate.metrics);
    }))
    .map((x) => x.trip);
}

function dominatesTrip(
  a: TripOption,
  ma: TripRankMetrics,
  b: TripOption,
  mb: TripRankMetrics,
): boolean {
  // Price: incomparable currency means price doesn't decide dominance.
  const aComparable = ma.priceComparableKey !== "incomparable";
  const bComparable = mb.priceComparableKey !== "incomparable";
  let priceNoWorse = true;
  let priceStrictlyBetter = false;
  if (aComparable && bComparable) {
    const aCurrency = a.payment.cashByCurrency[0].currency;
    const bCurrency = b.payment.cashByCurrency[0].currency;
    if (aCurrency === bCurrency) {
      const cmp = compareMoney(a.payment.cashByCurrency[0], b.payment.cashByCurrency[0]);
      if (cmp > 0) priceNoWorse = false;  // a is more expensive -> doesn't dominate
      if (cmp < 0) priceStrictlyBetter = true;
    } else {
      // Different currencies: incomparable — cannot claim dominance via price
      priceNoWorse = true;
      priceStrictlyBetter = false;
    }
  } else {
    // At least one is incomparable (points / multi-currency) — price can't claim dominance
    priceNoWorse = true;
    priceStrictlyBetter = false;
  }

  const noWorse =
    priceNoWorse &&
    ma.durationMilliseconds <= mb.durationMilliseconds &&
    ma.segmentCount <= mb.segmentCount &&
    ma.bookingComponentCount <= mb.bookingComponentCount &&
    ma.worstProtectionRank <= mb.worstProtectionRank &&
    ma.stalenessRank <= mb.stalenessRank;

  const strictlyBetter =
    priceStrictlyBetter ||
    ma.durationMilliseconds < mb.durationMilliseconds ||
    ma.segmentCount < mb.segmentCount ||
    ma.bookingComponentCount < mb.bookingComponentCount ||
    ma.worstProtectionRank < mb.worstProtectionRank ||
    ma.stalenessRank < mb.stalenessRank;

  return noWorse && strictlyBetter;
}

// ---------------------------------------------------------------------------
// Advisory display score
// ---------------------------------------------------------------------------

function computeDisplayScore(metrics: TripRankMetrics, allMetrics: TripRankMetrics[]): number {
  // Price component: 0-40 pts. Only when comparable.
  let priceScore = 20; // neutral when incomparable
  const comparables = allMetrics.filter((m) => m.priceComparableKey !== "incomparable");
  if (metrics.priceComparableKey !== "incomparable" && comparables.length > 0) {
    const amounts = comparables.map((m) => BigInt(m.priceComparableKey.split(":")[1]));
    const minAmount = amounts.reduce((mn, v) => v < mn ? v : mn, amounts[0]);
    const maxAmount = amounts.reduce((mx, v) => v > mx ? v : mx, amounts[0]);
    const myAmount = BigInt(metrics.priceComparableKey.split(":")[1]);
    const range = maxAmount - minAmount;
    priceScore = range === 0n ? 40 : 40 - Number((myAmount - minAmount) * 40n / range);
  }

  // Duration component: 0-25 pts
  const durations = allMetrics.map((m) => m.durationMilliseconds);
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  const durationRange = maxDuration - minDuration;
  const durationScore = durationRange === 0 ? 25 : 25 * (1 - (metrics.durationMilliseconds - minDuration) / durationRange);

  // Segment count: 0-15 pts
  const segs = allMetrics.map((m) => m.segmentCount);
  const minSeg = Math.min(...segs);
  const maxSeg = Math.max(...segs);
  const segRange = maxSeg - minSeg;
  const segScore = segRange === 0 ? 15 : 15 * (1 - (metrics.segmentCount - minSeg) / segRange);

  // Protection: 0-10 pts
  const protScore = (2 - metrics.worstProtectionRank) * 5;

  // Staleness: 0-10 pts
  const staleScore = (1 - metrics.stalenessRank) * 10;

  return priceScore + durationScore + segScore + protScore + staleScore;
}

// ---------------------------------------------------------------------------
// Main ranking function
// ---------------------------------------------------------------------------

/**
 * Deterministically ranks an array of TripOptions.
 * - Parses all inputs through TripOptionSchema.
 * - Returns a stable sorted RankedTripOption[].
 * - Empty input => empty result.
 */
export function rankTripOptions(
  rawTrips: readonly unknown[],
  rawPolicy: unknown,
): TripRankingResult {
  const policy = TripRankingPolicySchema.parse(rawPolicy);
  const trips: TripOption[] = rawTrips.map((t) => TripOptionSchema.parse(t));

  if (trips.length === 0) {
    return TripRankingResultSchema.parse({ ranked: [], diagnostics: [] });
  }

  const metricsMap = new Map<string, TripRankMetrics>();
  for (const trip of trips) {
    metricsMap.set(trip.id, tripRankMetrics(trip, policy));
  }
  const allMetrics = trips.map((t) => metricsMap.get(t.id)!);

  // Detect mixed-currency incomparability for diagnostics and comparator configuration.
  // A trip carries price_incomparable_currency when:
  // (a) its own payment is incomparable (points / multi-currency), OR
  // (b) there are trips in the result set with a different currency, making
  //     a full cross-trip price comparison impossible.
  const comparableCurrencies = new Set<string>();
  for (const metrics of allMetrics) {
    if (metrics.priceComparableKey !== "incomparable") {
      comparableCurrencies.add(metrics.priceComparableKey.split(":")[0]);
    }
  }
  const hasAnyIncomparable = allMetrics.some((m) => m.priceComparableKey === "incomparable");
  const hasMixedCurrency = comparableCurrencies.size > 1 || hasAnyIncomparable;
  const diagnostics: string[] = [];
  if (hasMixedCurrency) diagnostics.push("mixed_currency_incomparable");

  // commonCurrency: the single shared cash currency when ALL trips agree; null otherwise.
  // This is passed to the comparator so price ranking is applied GLOBALLY (all-or-nothing),
  // never per-pair — a per-pair check would create intransitivity cycles in mixed sets.
  const commonCurrency: string | null =
    !hasAnyIncomparable && comparableCurrencies.size === 1
      ? [...comparableCurrencies][0]
      : null;

  // Compute context for reasons
  const minDuration = Math.min(...allMetrics.map((m) => m.durationMilliseconds));
  const minSegments = Math.min(...allMetrics.map((m) => m.segmentCount));

  // Find cheapest among comparable same-currency groups
  const cheapestByKey = new Map<string, string>(); // currency -> amountMinor (string of the min)
  for (const metrics of allMetrics) {
    if (metrics.priceComparableKey === "incomparable") continue;
    const [currency, amountStr] = metrics.priceComparableKey.split(":");
    const existing = cheapestByKey.get(currency);
    if (existing === undefined || BigInt(amountStr) < BigInt(existing)) {
      cheapestByKey.set(currency, amountStr);
    }
  }

  // Stable sort by comparator — commonCurrency is passed so price is applied consistently
  // across all pairs, not per-pair, which would break transitivity on mixed-currency sets.
  const sorted = [...trips].sort((a, b) => compareTripOptions(a, b, policy, commonCurrency));

  const ranked: RankedTripOption[] = sorted.map((trip, idx) => {
    const metrics = metricsMap.get(trip.id)!;
    const currency = trip.payment.cashByCurrency[0]?.currency;
    const amountMinor = trip.payment.cashByCurrency[0]?.amountMinor;
    const isCheapest = metrics.priceComparableKey !== "incomparable" &&
      currency !== undefined &&
      amountMinor !== undefined &&
      cheapestByKey.get(currency) === amountMinor;
    const isFastest = metrics.durationMilliseconds === minDuration;
    const isFewestStops = metrics.segmentCount === minSegments;
    // A trip has an incomparable price when its own payment is non-comparable (points/multi-currency)
    // OR when the result set contains trips with different currencies.
    const ownCurrency = metrics.priceComparableKey !== "incomparable"
      ? metrics.priceComparableKey.split(":")[0]
      : null;
    const hasPriceIncomparableCurrency =
      metrics.priceComparableKey === "incomparable" ||
      (ownCurrency !== null && (comparableCurrencies.size > 1 || hasAnyIncomparable));

    const reasons = tripReasons(trip, metrics, policy, {
      isCheapest,
      isFastest,
      isFewestStops,
      hasPriceIncomparableCurrency,
    });

    const displayScore = computeDisplayScore(metrics, allMetrics);

    return RankedTripOptionSchema.parse({
      rank: idx,
      trip,
      metrics,
      displayScore,
      reasons,
    });
  });

  return TripRankingResultSchema.parse({ ranked, diagnostics });
}
