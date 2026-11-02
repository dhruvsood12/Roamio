import { TrustedExecutionContextSchema, type TrustedExecutionContext } from "@flightbrain/composer";
import { RouteCandidateSchema, type RouteCandidate } from "@flightbrain/domain";
import { airportLocation, discoveryEvidence, discoveryLeg, discoveryRequest } from "./discovery";

// Derives a matching trusted execution context from discoveryRequest() with a generous budget.
// All fields align with the canonical discovery fixture (request-1, DEL→SFO, unspecified departure, no passengers).
export function trustedExecutionContext(change: Partial<TrustedExecutionContext> = {}): TrustedExecutionContext {
  const req = discoveryRequest();
  return TrustedExecutionContextSchema.parse({
    requestId: req.requestId,
    asOf: "2026-09-21T10:00:00Z",
    departure: req.departure,
    passengers: req.passengers,
    budget: {
      maxProviderIntents: 1_000,
      alreadyConsumedIntents: 0,
      maxCandidateAgeMs: 300_000, // 5 minutes — generous for fixture use
    },
    ...change,
  });
}

// Synthetic single-leg DEL->SFO candidate whose one route-exists fact carries a finite
// observedAt/expiresAt window, so tests can exercise the evidence-freshness staleness
// branch (distinct from the candidate-age branch). Entirely synthetic; no real claims.
export function expiringEvidenceCandidate(
  expiresAt: string | null,
  observedAt: string | null = null,
  discoveredAt = "2026-09-21T10:00:00Z",
): RouteCandidate {
  return RouteCandidateSchema.parse({
    kind: "route_candidate", id: "expiring-1", requestId: "request-1",
    source: { sourceId: "synthetic-source", kind: "external", externalRouteId: null },
    discoveredAt,
    legs: [{ ...discoveryLeg(0), origin: airportLocation("DEL"), destination: airportLocation("SFO") }],
    evidence: [{ ...discoveryEvidence(0), observedAt, expiresAt }],
    estimatedDurationMinutes: null, estimatedPrice: null,
  });
}
