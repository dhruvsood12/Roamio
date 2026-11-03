/**
 * C015 — watch.ts
 *
 * Pure, deterministic watch evaluation function.
 * A thin INTERPRETATION layer over C009 revalidateSearch.
 *
 * Given a WatchDefinition + injected deps:
 *   1. Build PriorResult from watch.request + watch.lastResult.
 *   2. Call revalidateSearch(prior, deps) — no independent diffing.
 *   3. Interpret diff.changes vs watch.criteria to produce WatchTriggerHit[].
 *   4. Return WatchUpdate (triggered, hits, priorBest, newBest, refetched, diff, diagnostics).
 *
 * Honesty invariants:
 *   - Every hit.stableKey/category/derivedFrom is verified to exist in diff.changes.
 *   - price_drop fires ONLY on price_changed where new best cash < prior best cash IN A SHARED
 *     CURRENCY (read from priceComparableKey); never on mixed_currency_incomparable.
 *   - price_under_ceiling fires ONLY when maxCashPriceMinor is set AND new best comparable cash
 *     in cashCurrency <= ceiling; no default ceiling.
 *   - award_became_available fires ONLY when trip.payment.pointsByProgram is non-empty; never
 *     reports a points cost or cash-equivalent.
 *   - notifyOnAnyBetter → new_better_option/improved; notifyOnExpiry → offer_expired/became_unavailable;
 *     notifyOnNewOption → became_available.
 *   - No independent comparator; "better" is strictly C009's diff categories.
 *
 * No wall-clock calls: no now-timestamp read, no stdlib randomness, no bare no-arg Date
 * construction, and no network fetch — all time comes from the injected asOf.
 * No @flightbrain/providers import. No node:crypto/node:fetch.
 */

import { z } from "zod";
import {
  revalidateSearch,
  stableTripKey,
  RevalidationDiffSchema,
  type RevalidationDiff,
  type RevalidationDeps,
  type PriorResult,
} from "@flightbrain/revalidation";
import {
  SearchResponseSchema,
  SearchApiRequestSchema,
  type SearchResponse,
} from "@flightbrain/search-api";
import { TripRankMetricsSchema, type TripRankMetrics } from "@flightbrain/ranking";

// ---------------------------------------------------------------------------
// WatchCriteriaSchema — ≥1 field must be set (superRefine enforces)
// ---------------------------------------------------------------------------

export const WatchCriteriaSchema = z.strictObject({
  /** Fire when diff reports a new_better_option or improved trip. */
  notifyOnAnyBetter: z.boolean().optional(),
  /** Fire when the best trip's cash price drops (shared currency only). */
  notifyOnPriceDrop: z.boolean().optional(),
  /** Fire when the best trip's cash price in cashCurrency drops at or below maxCashPriceMinor. */
  maxCashPriceMinor: z.string().regex(/^(?:0|[1-9][0-9]*)$/).optional(),
  /** ISO 4217 currency for the ceiling comparison. Required when maxCashPriceMinor is set. */
  cashCurrency: z.enum(["EUR", "GBP", "INR", "JPY", "KWD", "SEK", "USD"]).optional(),
  /** Fire when a trip that uses points (award) becomes available. */
  notifyOnAwardBecameAvailable: z.boolean().optional(),
  /** Fire when any trip expires or becomes unavailable. */
  notifyOnExpiry: z.boolean().optional(),
  /** Fire when a genuinely new trip option becomes available. */
  notifyOnNewOption: z.boolean().optional(),
}).superRefine((criteria, ctx) => {
  const hasAny =
    criteria.notifyOnAnyBetter === true ||
    criteria.notifyOnPriceDrop === true ||
    criteria.maxCashPriceMinor !== undefined ||
    criteria.notifyOnAwardBecameAvailable === true ||
    criteria.notifyOnExpiry === true ||
    criteria.notifyOnNewOption === true;

  if (!hasAny) {
    ctx.addIssue({
      code: "custom",
      message: "WatchCriteria requires at least one criterion to be set",
    });
  }
});
export type WatchCriteria = z.infer<typeof WatchCriteriaSchema>;

// ---------------------------------------------------------------------------
// WatchDefinitionSchema
// ---------------------------------------------------------------------------

export const WatchDefinitionSchema = z.strictObject({
  request: SearchApiRequestSchema,
  lastResult: SearchResponseSchema,
  criteria: WatchCriteriaSchema,
});
export type WatchDefinition = z.infer<typeof WatchDefinitionSchema>;

// ---------------------------------------------------------------------------
// WatchTriggerSchema — enum 1:1 with criteria fields
// ---------------------------------------------------------------------------

export const WatchTriggerSchema = z.enum([
  "any_better",
  "price_drop",
  "price_under_ceiling",
  "award_became_available",
  "offer_expired_or_unavailable",
  "new_option",
]);
export type WatchTrigger = z.infer<typeof WatchTriggerSchema>;

// ---------------------------------------------------------------------------
// WatchTriggerHitSchema — binds each fired trigger to the exact TripChange
// ---------------------------------------------------------------------------

export const WatchTriggerHitSchema = z.strictObject({
  trigger: WatchTriggerSchema,
  stableKey: z.string().min(1),
  derivedFrom: z.array(z.string()),
  category: z.string().min(1),
});
export type WatchTriggerHit = z.infer<typeof WatchTriggerHitSchema>;

// ---------------------------------------------------------------------------
// WatchBestSchema — rank-0 trip projection
// ---------------------------------------------------------------------------

export const WatchBestSchema = z.strictObject({
  stableKey: z.string().min(1),
  metrics: TripRankMetricsSchema.nullable(),
});
export type WatchBest = z.infer<typeof WatchBestSchema>;

// ---------------------------------------------------------------------------
// WatchUpdateSchema — the full result
// ---------------------------------------------------------------------------

export const WatchUpdateSchema = z.strictObject({
  triggered: z.boolean(),
  hits: z.array(WatchTriggerHitSchema),
  priorBest: WatchBestSchema.nullable(),
  newBest: WatchBestSchema.nullable(),
  refetched: z.boolean(),
  diff: RevalidationDiffSchema,
  diagnostics: z.array(z.string()),
});
export type WatchUpdate = z.infer<typeof WatchUpdateSchema>;

// ---------------------------------------------------------------------------
// WatchDeps — forwarded unchanged from RevalidationDeps
// ---------------------------------------------------------------------------

export type WatchDeps = RevalidationDeps;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a priceComparableKey from TripRankMetrics.
 * Returns { currency, amountMinor } when comparable (e.g. "USD:50000"),
 * or null when "incomparable".
 */
function parsePriceKey(key: string): { currency: string; amountMinor: bigint } | null {
  if (key === "incomparable") return null;
  const colonIdx = key.indexOf(":");
  if (colonIdx < 0) return null;
  const currency = key.slice(0, colonIdx);
  const amountStr = key.slice(colonIdx + 1);
  try {
    return { currency, amountMinor: BigInt(amountStr) };
  } catch {
    return null;
  }
}

/**
 * Derive WatchBest for the rank-0 trip in a SearchResponse.
 * Uses stableTripKey from @flightbrain/revalidation so the stableKey is consistent
 * with the diff's stableKey entries.
 */
function bestFromResponse(response: SearchResponse): WatchBest | null {
  if (response.trips.length === 0) return null;
  const ranked = response.trips[0];
  const key = stableTripKey(ranked.trip);
  return WatchBestSchema.parse({
    stableKey: key,
    metrics: ranked.metrics,
  });
}

// ---------------------------------------------------------------------------
// evaluateWatch — main entry point
// ---------------------------------------------------------------------------

export async function evaluateWatch(
  rawWatch: unknown,
  deps: WatchDeps,
): Promise<WatchUpdate> {
  // 1. Parse and validate the watch definition
  const watch = WatchDefinitionSchema.parse(rawWatch);
  const { request, lastResult, criteria } = watch;

  // 2. Build PriorResult for revalidateSearch
  const prior: PriorResult = {
    priorResponse: lastResult,
    request,
  };

  // 3. Call revalidateSearch — this is the ONLY diffing we do; no independent diffing
  const reval = await revalidateSearch(prior, deps);
  const { diff, refetched, revalidated } = reval;
  const revalDiagnostics = reval.diagnostics;

  const diagnostics: string[] = [...revalDiagnostics];

  // 4. Project priorBest / newBest (rank-0 trip, using stableTripKey for consistency)
  const priorBest: WatchBest | null = bestFromResponse(lastResult);
  const newBest: WatchBest | null = bestFromResponse(revalidated);

  // 5. Build an index from stableKey → new trip (for award check)
  const newTripByKey = new Map<string, (typeof revalidated.trips)[0]>();
  for (const rt of revalidated.trips) {
    newTripByKey.set(stableTripKey(rt.trip), rt);
  }

  // 6. Interpret diff.changes against criteria — no independent comparator
  const hits: WatchTriggerHit[] = [];

  for (const change of diff.changes) {
    const { stableKey, categories, derivedFrom } = change;

    // notifyOnAnyBetter → any_better (new_better_option or improved)
    if (criteria.notifyOnAnyBetter === true) {
      for (const cat of categories) {
        if (cat === "new_better_option" || cat === "improved") {
          hits.push(WatchTriggerHitSchema.parse({
            trigger: "any_better",
            stableKey,
            derivedFrom,
            category: cat,
          }));
        }
      }
    }

    // notifyOnExpiry → offer_expired_or_unavailable (offer_expired or became_unavailable)
    if (criteria.notifyOnExpiry === true) {
      for (const cat of categories) {
        if (cat === "offer_expired" || cat === "became_unavailable") {
          hits.push(WatchTriggerHitSchema.parse({
            trigger: "offer_expired_or_unavailable",
            stableKey,
            derivedFrom,
            category: cat,
          }));
        }
      }
    }

    // notifyOnNewOption → new_option (became_available)
    if (criteria.notifyOnNewOption === true) {
      for (const cat of categories) {
        if (cat === "became_available") {
          hits.push(WatchTriggerHitSchema.parse({
            trigger: "new_option",
            stableKey,
            derivedFrom,
            category: cat,
          }));
        }
      }
    }

    // award_became_available — became_available/new_better_option on a trip with pointsByProgram
    if (criteria.notifyOnAwardBecameAvailable === true) {
      const hasAwardCategory =
        categories.includes("became_available") || categories.includes("new_better_option");

      if (hasAwardCategory) {
        const newRankedTrip = newTripByKey.get(stableKey);
        if (newRankedTrip && newRankedTrip.trip.payment.pointsByProgram.length > 0) {
          for (const cat of categories) {
            if (cat === "became_available" || cat === "new_better_option") {
              hits.push(WatchTriggerHitSchema.parse({
                trigger: "award_became_available",
                stableKey,
                derivedFrom,
                category: cat,
              }));
            }
          }
        }
      }
    }
  }

  // 7. price_drop — fires only when:
  //    - notifyOnPriceDrop is true
  //    - priorBest and newBest exist with non-null metrics
  //    - new best cash < prior best cash in SAME single currency
  //    - NOT mixed_currency_incomparable
  if (
    criteria.notifyOnPriceDrop === true &&
    priorBest !== null &&
    newBest !== null &&
    priorBest.metrics !== null &&
    newBest.metrics !== null &&
    !diagnostics.includes("mixed_currency_incomparable")
  ) {
    const priorPrice = parsePriceKey(priorBest.metrics.priceComparableKey);
    const newPrice = parsePriceKey(newBest.metrics.priceComparableKey);

    if (
      priorPrice !== null &&
      newPrice !== null &&
      priorPrice.currency === newPrice.currency &&
      newPrice.amountMinor < priorPrice.amountMinor
    ) {
      // Attribute to the diff.changes entry for the new best trip that has price_changed
      const bestChange = diff.changes.find(
        (c) => c.stableKey === newBest.stableKey && c.categories.includes("price_changed"),
      );
      if (bestChange !== undefined) {
        hits.push(WatchTriggerHitSchema.parse({
          trigger: "price_drop",
          stableKey: bestChange.stableKey,
          derivedFrom: bestChange.derivedFrom,
          category: "price_changed",
        }));
      }
    }
  }

  // 8. price_under_ceiling — fires only when:
  //    - maxCashPriceMinor is set AND cashCurrency is set
  //    - new best comparable cash in cashCurrency <= ceiling
  //    - no default ceiling; no made-up currency
  if (
    criteria.maxCashPriceMinor !== undefined &&
    criteria.cashCurrency !== undefined &&
    newBest !== null &&
    newBest.metrics !== null
  ) {
    const newPrice = parsePriceKey(newBest.metrics.priceComparableKey);
    const ceiling = BigInt(criteria.maxCashPriceMinor);

    if (
      newPrice !== null &&
      newPrice.currency === criteria.cashCurrency &&
      newPrice.amountMinor <= ceiling
    ) {
      // Attribute to the new best trip's most relevant diff.changes entry
      const bestChange = diff.changes.find((c) => c.stableKey === newBest.stableKey);
      if (bestChange !== undefined) {
        hits.push(WatchTriggerHitSchema.parse({
          trigger: "price_under_ceiling",
          stableKey: bestChange.stableKey,
          derivedFrom: bestChange.derivedFrom,
          category: bestChange.categories[0] ?? "unchanged",
        }));
      }
    }
  }

  // 9. Deduplicate hits: (trigger, stableKey, category) tuple uniqueness
  const seenHits = new Set<string>();
  const deduped: WatchTriggerHit[] = [];
  for (const hit of hits) {
    const hitKey = `${hit.trigger}::${hit.stableKey}::${hit.category}`;
    if (!seenHits.has(hitKey)) {
      seenHits.add(hitKey);
      deduped.push(hit);
    }
  }

  return WatchUpdateSchema.parse({
    triggered: deduped.length > 0,
    hits: deduped,
    priorBest,
    newBest,
    refetched,
    diff,
    diagnostics,
  });
}
