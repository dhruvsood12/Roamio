/**
 * C007 request.ts — SearchApiRequest schema and helpers for building
 * TrustedExecutionContext, ledger, and RouteDiscoveryRequest from an API request.
 *
 * No wall clock; asOf is always injected.
 */

import { z } from "zod";
import {
  AirportCodeSchema,
  DateSchema,
  RouteDiscoveryRequestSchema,
  type RouteDiscoveryRequest,
} from "@flightbrain/domain";
import {
  emptyLedger,
  TrustedExecutionContextSchema,
  type ExecutionLedger,
  type TrustedExecutionContext,
} from "@flightbrain/composer";
import {
  OrchestrationPolicySchema,
  type OrchestrationPolicy,
} from "@flightbrain/orchestrator";
import { TripRankingPolicySchema } from "@flightbrain/ranking";

// ---------------------------------------------------------------------------
// SearchApiRequestSchema
// ---------------------------------------------------------------------------

export const SearchApiRequestSchema = z.strictObject({
  /** IATA codes for origin airports (1–5). */
  origins: z.array(AirportCodeSchema).min(1).max(5),
  /** IATA codes for destination airports (1–5). */
  destinations: z.array(AirportCodeSchema).min(1).max(5),
  /** Outbound departure date (YYYY-MM-DD). */
  departureDate: DateSchema,
  /** Return departure date for round-trips; must be >= departureDate. */
  returnDate: DateSchema.optional(),
  /** Number of adult passengers. */
  adults: z.number().int().positive().max(9),
  /** Cabin class preferences (all accepted; planning filters are downstream). */
  cabins: z.array(z.enum(["economy", "premium_economy", "business", "first"])).min(1),
  /** Maximum intermediate stops per direction (null = unlimited). */
  maxStops: z.number().int().nonnegative().max(10).nullable(),
  /** ISO 4217 currency for price display. */
  currency: z.enum(["EUR", "GBP", "INR", "JPY", "KWD", "SEK", "USD"]),
  /** ISO 3166-1 alpha-2 market code for localisation. */
  market: z.string().regex(/^[A-Z]{2}$/).optional(),
}).superRefine((req, ctx) => {
  // origin must not equal destination
  const origSet = new Set(req.origins);
  for (const dest of req.destinations) {
    if (origSet.has(dest)) {
      ctx.addIssue({
        code: "custom",
        path: ["destinations"],
        message: `Destination airport "${dest}" is also listed as an origin`,
      });
    }
  }
  // returnDate must be >= departureDate when present
  if (req.returnDate !== undefined && req.returnDate < req.departureDate) {
    ctx.addIssue({
      code: "custom",
      path: ["returnDate"],
      message: "returnDate must be on or after departureDate",
    });
  }
});

export type SearchApiRequest = z.infer<typeof SearchApiRequestSchema>;

// ---------------------------------------------------------------------------
// SearchApiPolicySchema — planning knobs + orchestration policy knobs
// (asOf is NOT here — it is injected by the caller)
// ---------------------------------------------------------------------------

export const SearchApiPolicySchema = z.strictObject({
  /** Maximum provider intents for the ledger budget. */
  maxProviderIntents: z.number().int().positive().max(10_000).default(200),
  /** Maximum candidate age in milliseconds for discovery freshness. */
  maxCandidateAgeMs: z.number().int().positive().default(300_000),
  /** Maximum discovery candidates to plan against. */
  maxCandidates: z.number().int().positive().max(1_000).default(50),
  /** Maximum legs per route candidate. */
  maxLegsPerCandidate: z.number().int().positive().max(32).default(8),
  /** Maximum verification jobs to plan. */
  maxJobs: z.number().int().positive().max(10_000).default(500),
  /** Seed for deterministic mock intake. */
  mockIntakeSeed: z.number().int().nonnegative().default(42),
  /** Number of offers per descriptor from the mock port. */
  offersPerDescriptor: z.number().int().positive().max(20).default(2),
  /** Offer validity window in milliseconds. */
  offerValidityMs: z.number().int().positive().default(3_600_000),
  /** Minimum connection time in minutes. */
  minConnectionMinutes: z.number().int().nonnegative().default(30),
  /** Whether airport changes are allowed for connections. */
  allowAirportChange: z.boolean().default(true),
  /** Transfer time required when airport changes (minutes). */
  airportChangeTransferMinutes: z.number().int().positive().nullable().default(60),
});

export type SearchApiPolicy = z.infer<typeof SearchApiPolicySchema>;

// ---------------------------------------------------------------------------
// toRouteDiscoveryRequest — converts a SearchApiRequest into a RouteDiscoveryRequest
// ---------------------------------------------------------------------------

/**
 * Builds a RouteDiscoveryRequest from a validated SearchApiRequest.
 * Uses the first origin/destination for point-to-point; multi-origin/dest
 * support is downstream (search-api exposes 1-N as an API affordance, but
 * the discovery contract is per-route).
 */
export function toRouteDiscoveryRequest(
  request: SearchApiRequest,
  requestId: string,
): RouteDiscoveryRequest {
  return RouteDiscoveryRequestSchema.parse({
    requestId,
    origin: { kind: "airport", iataCode: request.origins[0] },
    destination: { kind: "airport", iataCode: request.destinations[0] },
    departure: { kind: "date", date: request.departureDate },
    allowedModes: ["flight"],
    maxIntermediateStops: request.maxStops,
    passengers: { count: request.adults },
  });
}

// ---------------------------------------------------------------------------
// buildTrustedExecutionContext
// ---------------------------------------------------------------------------

export function buildTrustedExecutionContext(
  request: SearchApiRequest,
  requestId: string,
  asOf: string,
  policy: SearchApiPolicy,
): TrustedExecutionContext {
  return TrustedExecutionContextSchema.parse({
    requestId,
    asOf,
    departure: { kind: "date", date: request.departureDate },
    passengers: { count: request.adults },
    budget: {
      maxProviderIntents: policy.maxProviderIntents,
      alreadyConsumedIntents: 0,
      maxCandidateAgeMs: policy.maxCandidateAgeMs,
    },
  });
}

// ---------------------------------------------------------------------------
// buildInitialLedger — wraps emptyLedger
// ---------------------------------------------------------------------------

export function buildInitialLedger(requestId: string): ExecutionLedger {
  return emptyLedger(requestId);
}

// ---------------------------------------------------------------------------
// buildOrchestrationPolicy — assembles OrchestrationPolicy from SearchApiPolicy + injected asOf
// ---------------------------------------------------------------------------

export function buildOrchestrationPolicy(
  policy: SearchApiPolicy,
  asOf: string,
  currency: SearchApiRequest["currency"],
): OrchestrationPolicy {
  return OrchestrationPolicySchema.parse({
    connectionPolicy: {
      minConnectionMinutes: policy.minConnectionMinutes,
      allowAirportChange: policy.allowAirportChange,
      airportChangeTransferMinutes: policy.airportChangeTransferMinutes,
      rolloverReference: { kind: "utc_instant" },
    },
    mockIntakePolicy: {
      asOf,
      seed: policy.mockIntakeSeed,
      offersPerDescriptor: policy.offersPerDescriptor,
      offerValidityMs: policy.offerValidityMs,
      currency,
    },
    mockProvenance: {
      providerId: "mock:search-api",
      synthetic: true,
      disclaimer: "SYNTHETIC DATA — offline default; no real fares or carriers.",
    },
    rankingPolicy: TripRankingPolicySchema.parse({
      asOf,
      preferredCurrency: currency,
    }),
    ledgerBudget: {
      maxProviderIntents: policy.maxProviderIntents,
      maxCandidateAgeMs: policy.maxCandidateAgeMs,
    },
    asOf,
  });
}
