/**
 * C007 response.ts — SearchResponse schema and projection from OrchestrationResult.
 *
 * SAFE PROJECTION: TripOption.sourceOffers are always TripSourceSnapshot (never raw
 * providerMetadata). This module reads only TripOption + TripRankingResult + diagnostics.
 */

import { z } from "zod";
import {
  TripOptionSchema,
  TripSourceSnapshotSchema,
  TimestampSchema,
  type TripOption,
} from "@flightbrain/domain";
import { TripRankMetricsSchema, TripRankReasonSchema, type RankedTripOption } from "@flightbrain/ranking";
import type { OrchestrationResult } from "@flightbrain/orchestrator";
import type { SearchApiRequest } from "./request";

// ---------------------------------------------------------------------------
// TripFreshnessSchema — per-response freshness summary across sourceOffers
// ---------------------------------------------------------------------------

export const TripFreshnessSchema = z.strictObject({
  /** Earliest retrievedAt across all sourceOffers (ISO 8601). */
  minRetrievedAt: TimestampSchema,
  /** Latest retrievedAt across all sourceOffers (ISO 8601). */
  maxRetrievedAt: TimestampSchema,
  /** Nearest (soonest) expiresAt across all sourceOffers; null if none set. */
  nearestExpiresAt: TimestampSchema.nullable(),
  /** True if ANY sourceOffer has requiresRevalidation=true or has expired (expiresAt <= asOf). */
  requiresRevalidation: z.boolean(),
});
export type TripFreshness = z.infer<typeof TripFreshnessSchema>;

// ---------------------------------------------------------------------------
// RankedTripResultSchema — the response-level ranked trip entry
// ---------------------------------------------------------------------------

export const RankedTripResultSchema = z.strictObject({
  /** Trip with sourceOffers containing ONLY TripSourceSnapshot fields (no providerMetadata). */
  trip: TripOptionSchema,
  /** Rank metrics from C003 ranking. */
  metrics: TripRankMetricsSchema,
  /** Advisory ranking reasons (canonical order). */
  reasons: z.array(TripRankReasonSchema),
  /** Freshness summary across all source offers. */
  freshness: TripFreshnessSchema,
  /** True if any connection is self_transfer (not airline-protected). */
  hasSelfTransfer: z.boolean(),
  /** True if any connection protection is unknown. */
  hasUnknownProtection: z.boolean(),
  /** True if trip has at least one infeasible connection (trip would be excluded from results, so normally false). */
  fullyFeasible: z.boolean(),
});
export type RankedTripResult = z.infer<typeof RankedTripResultSchema>;

// ---------------------------------------------------------------------------
// SearchCoverageSchema
// ---------------------------------------------------------------------------

export const SearchCoverageSchema = z.strictObject({
  /** Number of route candidates discovered. */
  candidatesDiscovered: z.number().int().nonnegative(),
  /** Number of verification jobs planned. */
  jobsPlanned: z.number().int().nonnegative(),
  /** Number of jobs admitted for execution. */
  jobsAdmitted: z.number().int().nonnegative(),
  /** Number of intake calls that returned offers. */
  intakeOffered: z.number().int().nonnegative(),
  /** Number of intake calls that were declined. */
  intakeDeclined: z.number().int().nonnegative(),
  /** Number of trips composed. */
  tripsComposed: z.number().int().nonnegative(),
  /** Number of trips ranked. */
  tripsRanked: z.number().int().nonnegative(),
});
export type SearchCoverage = z.infer<typeof SearchCoverageSchema>;

// ---------------------------------------------------------------------------
// SearchDiagnosticsSchema
// ---------------------------------------------------------------------------

export const SearchDiagnosticsSchema = z.strictObject({
  /** Planning diagnostics from the VerificationPlan (candidate/job limits etc). */
  planningDiagnostics: z.array(z.string()),
  /** Admissibility diagnostics from E0 (request mismatch, budget, etc). */
  admissibilityDiagnostics: z.array(z.string()),
  /** Commercial resolution diagnostics from E1. */
  resolutionDiagnostics: z.array(z.string()),
  /** Composition diagnostics from E6. */
  compositionDiagnostics: z.array(z.string()),
  /** Orchestration-level diagnostics (pipeline-level). */
  orchestrationDiagnostics: z.array(z.string()),
  /** Ranking diagnostics from C003. */
  rankingDiagnostics: z.array(z.string()),
  /**
   * True when the ranked set contains trips with different currencies,
   * making cross-trip price comparison impossible without picking a preferred currency.
   */
  mixedCurrencyIncomparable: z.boolean(),
});
export type SearchDiagnostics = z.infer<typeof SearchDiagnosticsSchema>;

// ---------------------------------------------------------------------------
// SearchResponseSchema
// ---------------------------------------------------------------------------

export const SearchResponseSchema = z.strictObject({
  /** Stable hash of request + asOf (deterministic, no randomness). */
  searchId: z.string().min(1),
  /** Overall status of the search. */
  status: z.enum(["complete", "partial", "failed"]),
  /** Injected asOf timestamp (ISO 8601). */
  asOf: TimestampSchema,
  /** Coverage statistics for this search. */
  coverage: SearchCoverageSchema,
  /** Ranked trips (safe projection — sourceOffers are TripSourceSnapshot only). */
  trips: z.array(RankedTripResultSchema),
  /** Diagnostics from all pipeline stages. */
  diagnostics: SearchDiagnosticsSchema,
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// ---------------------------------------------------------------------------
// computeFreshness — per-trip freshness from TripOption.sourceOffers
// ---------------------------------------------------------------------------

function computeFreshness(trip: TripOption, asOf: string): TripFreshness {
  const asOfMs = Date.parse(asOf);
  let minRetrievedAt = trip.sourceOffers[0].retrievedAt;
  let maxRetrievedAt = trip.sourceOffers[0].retrievedAt;
  let nearestExpiresAt: string | null = null;
  let requiresRevalidation = false;

  for (const src of trip.sourceOffers) {
    if (src.retrievedAt < minRetrievedAt) minRetrievedAt = src.retrievedAt;
    if (src.retrievedAt > maxRetrievedAt) maxRetrievedAt = src.retrievedAt;

    if (src.requiresRevalidation) {
      requiresRevalidation = true;
    }

    if (src.expiresAt !== null && src.expiresAt !== undefined) {
      const expiresMs = Date.parse(src.expiresAt);
      if (expiresMs <= asOfMs) {
        requiresRevalidation = true;
      }
      if (nearestExpiresAt === null || src.expiresAt < nearestExpiresAt) {
        nearestExpiresAt = src.expiresAt;
      }
    }
  }

  return TripFreshnessSchema.parse({
    minRetrievedAt,
    maxRetrievedAt,
    nearestExpiresAt,
    requiresRevalidation,
  });
}

// ---------------------------------------------------------------------------
// projectRankedTrip — project RankedTripOption into RankedTripResult
// ---------------------------------------------------------------------------

function projectRankedTrip(ranked: RankedTripOption, asOf: string): RankedTripResult {
  const trip = ranked.trip;

  // Validate sourceOffers only contain TripSourceSnapshot keys.
  // The TripOption schema already stores TripSourceSnapshot in sourceOffers
  // (tripSourceSnapshot strips providerMetadata at E6 composition time).
  const freshness = computeFreshness(trip, asOf);

  const hasSelfTransfer = trip.connections.some((c) => c.protection === "self_transfer");
  const hasUnknownProtection = trip.connections.some((c) => c.protection === "unknown");

  // A trip in the ranked results is by definition feasibly composed, so fullyFeasible = true.
  const fullyFeasible = true;

  return RankedTripResultSchema.parse({
    trip,
    metrics: ranked.metrics,
    reasons: ranked.reasons,
    freshness,
    hasSelfTransfer,
    hasUnknownProtection,
    fullyFeasible,
  });
}

// ---------------------------------------------------------------------------
// toSearchResponse — project OrchestrationResult into SearchResponse
// ---------------------------------------------------------------------------

export function toSearchResponse(
  result: OrchestrationResult,
  request: SearchApiRequest,
  asOf: string,
  searchId: string,
  // Real discovery/planning counts threaded from the handler — they are not carried on
  // OrchestrationResult, so reporting them here keeps coverage honest (candidatesDiscovered
  // is the number of route candidates found, NOT the number of admissibility decisions).
  stats: { candidatesDiscovered: number; jobsPlanned: number },
): SearchResponse {
  const rankedTrips = result.ranking.ranked.map((r) => projectRankedTrip(r, asOf));

  // Coverage stats
  const intakeOffered = result.intake.filter((o) => o.outcome === "offered").length;
  const intakeDeclined = result.intake.filter((o) => o.outcome === "declined").length;
  const tripsComposed = result.composition.outcomes.filter((o) => o.outcome === "composed").length;

  const coverage = SearchCoverageSchema.parse({
    candidatesDiscovered: stats.candidatesDiscovered,
    jobsPlanned: stats.jobsPlanned,
    jobsAdmitted: result.admissibility.admissibleJobIds.length,
    intakeOffered,
    intakeDeclined,
    tripsComposed,
    tripsRanked: result.ranking.ranked.length,
  });

  // Diagnostics
  const mixedCurrencyIncomparable = result.ranking.diagnostics.includes("mixed_currency_incomparable");

  const diagnostics = SearchDiagnosticsSchema.parse({
    planningDiagnostics: [],
    admissibilityDiagnostics: result.admissibility.diagnostics,
    resolutionDiagnostics: result.resolution.diagnostics,
    compositionDiagnostics: result.composition.outcomes
      .filter((o) => o.outcome !== "composed")
      .map((o) => (o as Extract<typeof o, { outcome: string; reason?: string }>).reason ?? o.outcome),
    orchestrationDiagnostics: result.diagnostics,
    rankingDiagnostics: result.ranking.diagnostics.filter((d) => d !== "mixed_currency_incomparable"),
    mixedCurrencyIncomparable,
  });

  // Status derivation, by diagnostic SEVERITY (not raw count).
  // - "failed": only a genuine pipeline error (an internal inconsistency that makes the
  //   results untrustworthy). A provider simply DECLINING to offer, zero candidates, or
  //   nothing admissible are all honest no-results → "complete", never "failed".
  // - "partial": trips were produced but some coverage was lost (a provider declined / a
  //   budget cap truncated intake).
  // - "complete": everything else, including an honest empty result.
  const HARD_ERROR_DIAGNOSTICS = ["plan_request_mismatch"];
  const INCOMPLETE_COVERAGE_DIAGNOSTICS = ["intake_declined", "replay_budget_capped", "budget_exhausted"];
  const hasHardError = result.diagnostics.some((d) => HARD_ERROR_DIAGNOSTICS.includes(d));
  const hasIncompleteCoverage = result.diagnostics.some((d) => INCOMPLETE_COVERAGE_DIAGNOSTICS.includes(d));

  let status: "complete" | "partial" | "failed";
  if (hasHardError) {
    status = "failed";
  } else if (rankedTrips.length > 0 && hasIncompleteCoverage) {
    status = "partial";
  } else {
    status = "complete";
  }

  return SearchResponseSchema.parse({
    searchId,
    status,
    asOf,
    coverage,
    trips: rankedTrips,
    diagnostics,
  });
}
