/**
 * C009 — revalidation.ts
 *
 * Pure, deterministic revalidation function.
 * Given a PRIOR ranked result + an injected asOf + policy:
 *   1. Classify each trip's freshness against asOf via tripStaleness (delegate, not re-derive).
 *   2. If any trip requires re-fetch (per policy), re-run the SAME request via handleSearch
 *      with the INJECTED ProviderIntakePort (offline mock today).
 *   3. Emit a revalidated SearchResponse + an honest field-derived change diff.
 *
 * No wall-clock calls (Date-now, Math-random, new Date without args, fetch) — asOf is always injected.
 * No @flightbrain/providers import. No node:crypto/node:fetch.
 *
 * Trip identity decision:
 *   Trip IDs are volatile (trip:job:<jobId>:offer:<offerId>; both change per mock re-run).
 *   The scheduleFingerprint is a deterministic SHA-256 of OPERATING identity (operatingCarrier,
 *   operatingFlightNumber, times) and is STABLE across re-runs for the same schedule. We use it
 *   combined with route+segmentCount as the stable key (PRIMARY path, real providers / C006).
 *   On current synthetic data, operatingCarrier/operatingFlightNumber are always null, so
 *   itineraryFingerprint always returns null and scheduleFingerprint is always null. In that case
 *   the SCHEDULE-CONTENT fallback activates: we build a deterministic key from marketing identity
 *   (marketingCarrier, marketingFlightNumber) + times across all sourceOffer segments. This is
 *   stable across re-runs regardless of jobId/offerId churn. A "schedule_key_fallback" diagnostic
 *   is emitted when this path is taken. Only a fully degenerate trip (no segments at all) falls
 *   back to trip.id (with "schedule_key_degenerate_fallback").
 *
 * Allowed imports: @flightbrain/domain, @flightbrain/ranking, @flightbrain/orchestrator,
 *                  @flightbrain/search-api, zod, local ./
 */

import { z } from "zod";
import {
  tripStaleness,
  TripRankMetricsSchema,
  tripRankMetrics,
  TripRankingPolicySchema,
  type TripRankMetrics,
} from "@flightbrain/ranking";
import { compareMoney, type TripOption } from "@flightbrain/domain";
import {
  handleSearch,
  SearchResponseSchema,
  SearchApiRequestSchema,
  type SearchResponse,
  type RouteDiscoverySource,
} from "@flightbrain/search-api";
import {
  type ProviderIntakePort,
} from "@flightbrain/orchestrator";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const RevalidationPolicySchema = z.strictObject({
  asOf: z.string().datetime({ offset: true }).or(
    z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  ),
  preferredCurrency: z.enum(["EUR", "GBP", "INR", "JPY", "KWD", "SEK", "USD"]).optional(),
  /**
   * "refetch_always": re-fetch both expired AND requiresRevalidation trips
   * "only_when_expired": re-fetch ONLY expired trips; requiresRevalidation-only → skip re-fetch
   */
  refetchMode: z.enum(["refetch_always", "only_when_expired"]).default("refetch_always"),
});
export type RevalidationPolicy = z.infer<typeof RevalidationPolicySchema>;

export const FreshnessClassSchema = z.enum(["fresh", "requires_revalidation", "expired", "unknown"]);
export type FreshnessClass = z.infer<typeof FreshnessClassSchema>;

export const PriorResultSchema = z.strictObject({
  priorResponse: SearchResponseSchema,
  request: SearchApiRequestSchema,
});
export type PriorResult = z.infer<typeof PriorResultSchema>;

export const ChangeCategorySchema = z.enum([
  "unchanged",
  "price_changed",
  "offer_expired",
  "became_unavailable",
  "new_better_option",
  "improved",
  "worsened",
  "became_available",
]);
export type ChangeCategory = z.infer<typeof ChangeCategorySchema>;

export const TripChangeSchema = z.strictObject({
  stableKey: z.string().min(1),
  priorFreshness: FreshnessClassSchema,
  newFreshness: FreshnessClassSchema.nullable(),
  priorMetrics: TripRankMetricsSchema.nullable(),
  newMetrics: TripRankMetricsSchema.nullable(),
  categories: z.array(ChangeCategorySchema),
  derivedFrom: z.array(z.string()),
});
export type TripChange = z.infer<typeof TripChangeSchema>;

export const RevalidationDiffSchema = z.strictObject({
  changes: z.array(TripChangeSchema),
  hasNewBetterOption: z.boolean(),
  anyExpired: z.boolean(),
  refetchedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
});
export type RevalidationDiff = z.infer<typeof RevalidationDiffSchema>;

export const RevalidationResultSchema = z.strictObject({
  revalidated: SearchResponseSchema,
  diff: RevalidationDiffSchema,
  refetched: z.boolean(),
  diagnostics: z.array(z.string()),
});
export type RevalidationResult = z.infer<typeof RevalidationResultSchema>;

// ---------------------------------------------------------------------------
// RevalidationDeps — mirrors SearchApiDeps minus SearchApiPolicy to avoid
// name collision with the RevalidationPolicy field.
// ---------------------------------------------------------------------------

export type RevalidationDeps = {
  asOf: string;
  port?: ProviderIntakePort;
  discovery?: RouteDiscoverySource;
  policy: RevalidationPolicy;
};

// ---------------------------------------------------------------------------
// classifyTripFreshness — thin wrapper delegating to tripStaleness
// ---------------------------------------------------------------------------

/**
 * Classify freshness of a trip against asOf.
 * Delegates to tripStaleness (inclusive boundary: expiresAt <= asOf → expired).
 * "unknown" = NO expiresAt AND requiresRevalidation=false → cannot assert staleness.
 */
export function classifyTripFreshness(
  trip: TripOption,
  asOfMs: number,
  _policy: RevalidationPolicy,
): FreshnessClass {
  const staleness = tripStaleness(trip, asOfMs);

  if (staleness.rank === 1) {
    // Stale: determine whether expired (expiresAt <= asOf) or just requiresRevalidation
    for (const src of trip.sourceOffers) {
      if (src.expiresAt != null && Date.parse(src.expiresAt) <= asOfMs) {
        return "expired";
      }
    }
    return "requires_revalidation";
  }

  // rank=0: tripStaleness says not stale
  // If NO source has expiresAt AND none has requiresRevalidation → unknown (cannot assert freshness)
  const hasExpiry = trip.sourceOffers.some((s) => s.expiresAt != null);
  const hasRevalidationFlag = trip.sourceOffers.some((s) => s.requiresRevalidation);
  if (!hasExpiry && !hasRevalidationFlag) return "unknown";
  return "fresh";
}

// ---------------------------------------------------------------------------
// stableTripKey — deterministic identity key across re-runs
// ---------------------------------------------------------------------------

/**
 * Stable identity key across re-runs for the same schedule.
 *
 * Trip IDs embed a volatile jobId and offer.id (both reassigned per mock run).
 * The scheduleFingerprint is a deterministic SHA-256 of OPERATING identity
 * (operatingCarrier, operatingFlightNumber, times) and is STABLE across re-runs
 * for the same schedule. We combine it with route info (origin, destination,
 * segmentCount) to disambiguate trips on different routes.
 *
 * IMPORTANT: On current synthetic data the composer mock hardcodes
 * operatingCarrier/operatingFlightNumber = null for every segment, so
 * itineraryFingerprint always returns null and scheduleFingerprint is always null.
 * The PRIMARY (fingerprint) path activates only for real providers (C006) that
 * supply operating identity.
 *
 * When scheduleFingerprint is null (offline/synthetic path), we fall back to a
 * CONTENT-based key built from MARKETING identity + times across ALL sourceOffer
 * journeys/segments. This key is deterministic and stable across re-runs regardless
 * of jobId/offerId churn. A "schedule_key_fallback" diagnostic is surfaced when
 * this path is taken so it's transparent that operating-identity fingerprinting was
 * unavailable.
 *
 * If a trip has NO sourceOffers/segments at all (degenerate case), only then do we
 * fall back to trip.id with a "schedule_key_degenerate_fallback" diagnostic.
 */
export function stableTripKey(trip: TripOption): string {
  const fp = trip.bookingComponents[0]?.scheduleFingerprint;
  if (fp != null) {
    const origin = trip.travel.journeys[0]?.requestedOrigin ?? "?";
    const dest = trip.travel.journeys[0]?.requestedDestination ?? "?";
    const totalSegs = trip.travel.segmentCount;
    return `${fp}::${origin}::${dest}::${totalSegs}`;
  }

  // Build a content-based key from marketing identity + times across ALL sourceOffers.
  // Normalize timestamps the same way schedule.ts does: new Date(ts).toISOString().
  const parts: string[] = [];
  for (const sourceOffer of trip.sourceOffers) {
    for (const journey of sourceOffer.journeys) {
      for (const segment of journey.segments) {
        parts.push(
          [
            segment.origin,
            segment.destination,
            segment.marketingCarrier,
            segment.marketingFlightNumber,
            new Date(segment.departureAt).toISOString(),
            new Date(segment.arrivalAt).toISOString(),
          ].join("|")
        );
      }
    }
  }

  if (parts.length === 0) {
    // Degenerate: no segments at all — last resort fallback to trip.id
    return `sched:degenerate::${trip.id}`;
  }

  return `sched:${parts.join(",")}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildTripMetricSnapshot(
  trip: TripOption,
  asOf: string,
  policy: RevalidationPolicy,
): TripRankMetrics {
  const rankingPolicy = TripRankingPolicySchema.parse({
    asOf,
    preferredCurrency: policy.preferredCurrency,
  });
  return tripRankMetrics(trip, rankingPolicy);
}

/**
 * Compare prices between prior and new trip.
 * Returns { changed, derivedFrom } when currencies match, null when incomparable.
 * Pushes "mixed_currency_incomparable" to diagnostics when currencies don't match.
 */
function comparePriceForDiff(
  priorTrip: TripOption,
  newTrip: TripOption,
  diagnostics: string[],
): { changed: boolean; derivedFrom: string } | null {
  const priorCash = priorTrip.payment.cashByCurrency;
  const newCash = newTrip.payment.cashByCurrency;
  if (
    priorCash.length === 1 &&
    newCash.length === 1 &&
    priorCash[0].currency === newCash[0].currency
  ) {
    const cmp = compareMoney(priorCash[0], newCash[0]);
    return { changed: cmp !== 0, derivedFrom: "cashByCurrency[0].amountMinor" };
  }
  if (!diagnostics.includes("mixed_currency_incomparable")) {
    diagnostics.push("mixed_currency_incomparable");
  }
  return null;
}

// ---------------------------------------------------------------------------
// revalidateSearch — main entry point
// ---------------------------------------------------------------------------

export async function revalidateSearch(
  rawPrior: unknown,
  deps: RevalidationDeps,
): Promise<RevalidationResult> {
  const prior = PriorResultSchema.parse(rawPrior);
  const revalPolicy = RevalidationPolicySchema.parse(deps.policy);
  const asOfMs = Date.parse(revalPolicy.asOf);

  // 1. Classify each prior trip's freshness
  const priorFreshnessMap = new Map<string, FreshnessClass>();
  for (const rt of prior.priorResponse.trips) {
    const key = stableTripKey(rt.trip);
    priorFreshnessMap.set(key, classifyTripFreshness(rt.trip, asOfMs, revalPolicy));
  }

  const freshnessValues = [...priorFreshnessMap.values()];
  const anyExpiredInPrior = freshnessValues.some((f) => f === "expired");
  const anyStaleInPrior = freshnessValues.some((f) => f === "expired" || f === "requires_revalidation");

  // 2. Decide if re-fetch is needed (per policy)
  let needsRefetch: boolean;
  if (revalPolicy.refetchMode === "refetch_always") {
    needsRefetch = anyStaleInPrior;
  } else {
    // only_when_expired
    needsRefetch = anyExpiredInPrior;
  }

  // 3. If all fresh: return prior unchanged, diff all unchanged, port NEVER called
  if (!needsRefetch || prior.priorResponse.trips.length === 0) {
    const diagnostics: string[] = [];

    const changes: TripChange[] = prior.priorResponse.trips.map((rt) => {
      const key = stableTripKey(rt.trip);
      const fp = rt.trip.bookingComponents[0]?.scheduleFingerprint;
      if (fp == null) {
        const diag = key.startsWith("sched:degenerate::") ? "schedule_key_degenerate_fallback" : "schedule_key_fallback";
        if (!diagnostics.includes(diag)) diagnostics.push(diag);
      }
      const priorFreshness = priorFreshnessMap.get(key) ?? "unknown";
      return TripChangeSchema.parse({
        stableKey: key,
        priorFreshness,
        newFreshness: priorFreshness,
        priorMetrics: buildTripMetricSnapshot(rt.trip, revalPolicy.asOf, revalPolicy),
        newMetrics: null,
        categories: ["unchanged"],
        derivedFrom: ["freshness"],
      });
    });

    const diff = RevalidationDiffSchema.parse({
      changes,
      hasNewBetterOption: false,
      anyExpired: anyExpiredInPrior,
      refetchedCount: 0,
      skippedCount: prior.priorResponse.trips.length,
    });

    return RevalidationResultSchema.parse({
      revalidated: prior.priorResponse,
      diff,
      refetched: false,
      diagnostics,
    });
  }

  // 4. Re-fetch: call handleSearch with injected port
  const freshResponse = await handleSearch(prior.request, {
    asOf: revalPolicy.asOf,
    ...(deps.port !== undefined ? { port: deps.port } : {}),
    ...(deps.discovery !== undefined ? { discovery: deps.discovery } : {}),
  });

  // 5. Build identity maps
  const diagnostics: string[] = [];

  // Detect mixed-currency incomparability at the set level:
  // if prior trips and new trips use different currencies, price comparison is impossible.
  const priorCurrencies = new Set(
    prior.priorResponse.trips
      .flatMap((rt) => rt.trip.payment.cashByCurrency.map((m) => m.currency))
  );
  const newCurrencies = new Set(
    freshResponse.trips
      .flatMap((rt) => rt.trip.payment.cashByCurrency.map((m) => m.currency))
  );
  const allCurrencies = new Set([...priorCurrencies, ...newCurrencies]);
  if (allCurrencies.size > 1) {
    diagnostics.push("mixed_currency_incomparable");
  }

  type PriorEntry = {
    trip: TripOption;
    priorFreshness: FreshnessClass;
    rank: number;
  };
  type NewEntry = {
    trip: TripOption;
    rank: number;
  };

  const priorMap = new Map<string, PriorEntry>();
  for (const [rank, rt] of prior.priorResponse.trips.entries()) {
    const key = stableTripKey(rt.trip);
    if (rt.trip.bookingComponents[0]?.scheduleFingerprint == null) {
      const diag = key.startsWith("sched:degenerate::") ? "schedule_key_degenerate_fallback" : "schedule_key_fallback";
      if (!diagnostics.includes(diag)) diagnostics.push(diag);
    }
    priorMap.set(key, {
      trip: rt.trip,
      priorFreshness: priorFreshnessMap.get(key) ?? "unknown",
      rank,
    });
  }

  const newMap = new Map<string, NewEntry>();
  for (const [rank, rt] of freshResponse.trips.entries()) {
    const key = stableTripKey(rt.trip);
    if (rt.trip.bookingComponents[0]?.scheduleFingerprint == null) {
      const diag = key.startsWith("sched:degenerate::") ? "schedule_key_degenerate_fallback" : "schedule_key_fallback";
      if (!diagnostics.includes(diag)) diagnostics.push(diag);
    }
    newMap.set(key, { trip: rt.trip, rank });
  }

  const bestPriorRank = prior.priorResponse.trips.length > 0 ? 0 : null;
  const changes: TripChange[] = [];

  // 5a. Diff each prior trip
  for (const [key, priorEntry] of priorMap) {
    const newEntry = newMap.get(key);

    if (newEntry === undefined) {
      // Became unavailable
      changes.push(TripChangeSchema.parse({
        stableKey: key,
        priorFreshness: priorEntry.priorFreshness,
        newFreshness: null,
        priorMetrics: buildTripMetricSnapshot(priorEntry.trip, revalPolicy.asOf, revalPolicy),
        newMetrics: null,
        categories: ["became_unavailable"],
        derivedFrom: ["trip.id"],
      }));
      continue;
    }

    const newFreshness = classifyTripFreshness(newEntry.trip, asOfMs, revalPolicy);
    const priorMetrics = buildTripMetricSnapshot(priorEntry.trip, revalPolicy.asOf, revalPolicy);
    const newMetrics = buildTripMetricSnapshot(newEntry.trip, revalPolicy.asOf, revalPolicy);

    const categories: ChangeCategory[] = [];
    const derivedFrom: string[] = [];

    // offer_expired: prior was expired
    if (priorEntry.priorFreshness === "expired") {
      categories.push("offer_expired");
      derivedFrom.push("expiresAt");
    }

    // price_changed
    const priceResult = comparePriceForDiff(priorEntry.trip, newEntry.trip, diagnostics);
    if (priceResult !== null && priceResult.changed) {
      categories.push("price_changed");
      derivedFrom.push(priceResult.derivedFrom);
    }

    // improved / worsened based on rank
    if (priorEntry.rank > newEntry.rank) {
      categories.push("improved");
      derivedFrom.push("rank");
    } else if (priorEntry.rank < newEntry.rank) {
      categories.push("worsened");
      derivedFrom.push("rank");
    }

    if (categories.length === 0) {
      categories.push("unchanged");
      derivedFrom.push("freshness");
    }

    changes.push(TripChangeSchema.parse({
      stableKey: key,
      priorFreshness: priorEntry.priorFreshness,
      newFreshness,
      priorMetrics,
      newMetrics,
      categories,
      derivedFrom,
    }));
  }

  // 5b. New trips not in prior
  for (const [key, newEntry] of newMap) {
    if (!priorMap.has(key)) {
      const newFreshness = classifyTripFreshness(newEntry.trip, asOfMs, revalPolicy);
      const newMetrics = buildTripMetricSnapshot(newEntry.trip, revalPolicy.asOf, revalPolicy);

      const categories: ChangeCategory[] = ["became_available"];
      const derivedFrom: string[] = ["trip.id"];

      // new_better_option: ranks better than the best prior trip (rank 0)
      if (bestPriorRank !== null && newEntry.rank < bestPriorRank) {
        categories.push("new_better_option");
        derivedFrom.push("rank");
        derivedFrom.push("trip.id");
      }

      changes.push(TripChangeSchema.parse({
        stableKey: key,
        priorFreshness: "unknown",
        newFreshness,
        priorMetrics: null,
        newMetrics,
        categories,
        derivedFrom,
      }));
    }
  }

  const hasNewBetterOption = changes.some((c) => c.categories.includes("new_better_option"));
  const anyExpiredInDiff = changes.some((c) => c.priorFreshness === "expired");

  const diff = RevalidationDiffSchema.parse({
    changes,
    hasNewBetterOption,
    anyExpired: anyExpiredInDiff,
    refetchedCount: prior.priorResponse.trips.filter((rt) => {
      const key = stableTripKey(rt.trip);
      const f = priorFreshnessMap.get(key) ?? "unknown";
      return f === "expired" || f === "requires_revalidation";
    }).length,
    skippedCount: prior.priorResponse.trips.filter((rt) => {
      const key = stableTripKey(rt.trip);
      const f = priorFreshnessMap.get(key) ?? "unknown";
      return f === "fresh" || f === "unknown";
    }).length,
  });

  return RevalidationResultSchema.parse({
    revalidated: freshResponse,
    diff,
    refetched: true,
    diagnostics,
  });
}
