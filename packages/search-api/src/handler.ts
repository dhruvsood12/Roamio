/**
 * C007 handler.ts — handleSearch: the pure deterministic core of the Search API.
 *
 * Maps a typed SearchApiRequest to a SearchResponse with:
 *   validate → discovery → planVerificationJobs →
 *   buildTrustedExecutionContext + buildInitialLedger + buildOrchestrationPolicy →
 *   runProviderOrchestration → toSearchResponse
 *
 * No HTTP server, no wall clock (asOf injected), no live providers (default = E4 mock).
 */

import { createHash } from "node:crypto";
import {
  planVerificationJobs,
} from "@flightbrain/composer";
import {
  RouteDiscoveryRequestSchema,
  type RouteCandidate,
  type RouteDiscoveryRequest,
  type RouteDiscoveryResult,
} from "@flightbrain/domain";
import {
  mockProviderIntakePort,
  runProviderOrchestration,
  type ProviderIntakePort,
} from "@flightbrain/orchestrator";
import {
  SearchApiRequestSchema,
  SearchApiPolicySchema,
  buildInitialLedger,
  buildOrchestrationPolicy,
  buildTrustedExecutionContext,
  toRouteDiscoveryRequest,
  type SearchApiPolicy,
  type SearchApiRequest,
} from "./request";
import { toSearchResponse, type SearchResponse } from "./response";

// ---------------------------------------------------------------------------
// RouteDiscoverySource — injected interface for offline / online discovery
// ---------------------------------------------------------------------------

/** Offline default abort signal — never fires. */
const NEVER_ABORT: AbortSignal = (() => {
  const ctrl = new AbortController();
  return ctrl.signal;
})();

export interface RouteDiscoverySource {
  /**
   * Returns RouteCandidate[] for a given RouteDiscoveryRequest.
   * Default offline implementation returns deterministic canonical candidates.
   */
  discover(request: RouteDiscoveryRequest): Promise<RouteCandidate[]>;
}

// ---------------------------------------------------------------------------
// offlineRouteDiscoverySource — deterministic synthetic default
// ---------------------------------------------------------------------------

/**
 * Offline route discovery source.
 * Produces canonical synthetic route candidates for airport-to-airport requests.
 * Clearly synthetic: all evidence is "hint"-level with null observedAt/expiresAt.
 */
function makeOfflineRouteDiscoverySource(asOf: string): RouteDiscoverySource {
  return {
    async discover(request: RouteDiscoveryRequest): Promise<RouteCandidate[]> {
      // Only produce candidates for airport-to-airport requests.
      if (request.origin.kind !== "airport" || request.destination.kind !== "airport") {
        return [];
      }

      const origin = request.origin.iataCode;
      const destination = request.destination.iataCode;
      const sourceId = "offline-canonical";

      // Build a direct single-leg candidate (nonstop).
      const nonstopCandidate: RouteCandidate = {
        kind: "route_candidate",
        id: `${origin}-${destination}-nonstop`,
        requestId: request.requestId,
        source: { sourceId, kind: "heuristic", externalRouteId: null },
        discoveredAt: asOf,
        legs: [
          {
            order: 0,
            origin: { kind: "airport", iataCode: origin },
            destination: { kind: "airport", iataCode: destination },
            mode: "flight",
            role: "travel",
            operator: null,
            serviceRef: null,
            scheduleState: "unknown",
            departureAt: null,
            arrivalAt: null,
            estimatedDurationMinutes: null,
            estimatedPrice: null,
          },
        ],
        evidence: [
          {
            factType: "route_exists",
            level: "hint",
            sourceId,
            target: { kind: "leg", legIndex: 0 },
            observedAt: null,
            expiresAt: null,
            sourceReference: null,
          },
        ],
        estimatedDurationMinutes: null,
        estimatedPrice: null,
      };

      // Build a 1-stop candidate via a canonical hub.
      // Uses a stable synthetic hub to keep the function deterministic.
      const hub = canonicalHub(origin, destination);
      const oneStopCandidate: RouteCandidate = {
        kind: "route_candidate",
        id: `${origin}-${hub}-${destination}-1stop`,
        requestId: request.requestId,
        source: { sourceId, kind: "heuristic", externalRouteId: null },
        discoveredAt: asOf,
        legs: [
          {
            order: 0,
            origin: { kind: "airport", iataCode: origin },
            destination: { kind: "airport", iataCode: hub },
            mode: "flight",
            role: "travel",
            operator: null,
            serviceRef: null,
            scheduleState: "unknown",
            departureAt: null,
            arrivalAt: null,
            estimatedDurationMinutes: null,
            estimatedPrice: null,
          },
          {
            order: 1,
            origin: { kind: "airport", iataCode: hub },
            destination: { kind: "airport", iataCode: destination },
            mode: "flight",
            role: "travel",
            operator: null,
            serviceRef: null,
            scheduleState: "unknown",
            departureAt: null,
            arrivalAt: null,
            estimatedDurationMinutes: null,
            estimatedPrice: null,
          },
        ],
        evidence: [
          {
            factType: "route_exists",
            level: "hint",
            sourceId,
            target: { kind: "leg", legIndex: 0 },
            observedAt: null,
            expiresAt: null,
            sourceReference: null,
          },
          {
            factType: "route_exists",
            level: "hint",
            sourceId,
            target: { kind: "leg", legIndex: 1 },
            observedAt: null,
            expiresAt: null,
            sourceReference: null,
          },
        ],
        estimatedDurationMinutes: null,
        estimatedPrice: null,
      };

      return [nonstopCandidate, oneStopCandidate];
    },
  };
}

/**
 * Returns a deterministic synthetic hub airport code for a route.
 * Uses a stable hash of origin+destination to pick from a fixed list.
 * Purely synthetic — no real routing claims.
 */
function canonicalHub(origin: string, destination: string): string {
  const hubs = ["DXB", "LHR", "AMS", "FRA", "DOH", "SIN", "NRT", "CDG"];
  // Pick a hub that is not origin or destination.
  const candidates = hubs.filter((h) => h !== origin && h !== destination);
  if (candidates.length === 0) return "DXB"; // fallback (very unlikely)
  const hash = createHash("sha256").update(`${origin}:${destination}`).digest("hex");
  const idx = parseInt(hash.slice(0, 8), 16) % candidates.length;
  return candidates[idx];
}

// ---------------------------------------------------------------------------
// SearchApiDeps
// ---------------------------------------------------------------------------

export type SearchApiDeps = {
  /** Injected clock instant — no wall clock in the core. */
  asOf: string;
  /** Route discovery source (default: offline synthetic). */
  discovery: RouteDiscoverySource;
  /** Provider intake port (default: E4 mock). */
  port: ProviderIntakePort;
  /** Planning and orchestration policy knobs. */
  policy: SearchApiPolicy;
};

/** Default deps: offline discovery + E4 mock port. */
export function defaultSearchApiDeps(asOf: string): SearchApiDeps {
  const policy = SearchApiPolicySchema.parse({});
  const mockPort = mockProviderIntakePort(
    {
      asOf,
      seed: policy.mockIntakeSeed,
      offersPerDescriptor: policy.offersPerDescriptor,
      offerValidityMs: policy.offerValidityMs,
      currency: "USD",
    },
    {
      providerId: "mock:search-api",
      synthetic: true,
      disclaimer: "SYNTHETIC DATA — offline default; no real fares or carriers.",
    },
  );
  return {
    asOf,
    discovery: makeOfflineRouteDiscoverySource(asOf),
    port: mockPort,
    policy,
  };
}

// ---------------------------------------------------------------------------
// stableSearchId — deterministic hash of (request, asOf)
// ---------------------------------------------------------------------------

function stableSearchId(request: SearchApiRequest, asOf: string): string {
  const payload = JSON.stringify({ request: SearchApiRequestSchema.parse(request), asOf });
  return "search:" + createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// handleSearch — the main handler function
// ---------------------------------------------------------------------------

/**
 * Core search handler. Validates input, orchestrates the pipeline, projects response.
 *
 * @param rawRequest - unknown input; ZodError thrown on malformed input before any work.
 * @param deps - injected asOf, discovery, port, policy (default = offline + mock port).
 * @returns SearchResponse — stable across identical inputs.
 */
export async function handleSearch(
  rawRequest: unknown,
  // `asOf` is REQUIRED and injected by the caller — the core reads no wall clock, so
  // results are deterministic. discovery/port/policy are optional (offline defaults).
  deps: Partial<SearchApiDeps> & { asOf: string },
): Promise<SearchResponse> {
  // Validate the request — ZodError thrown here on malformed input.
  const request = SearchApiRequestSchema.parse(rawRequest);

  const resolvedDeps: SearchApiDeps = {
    ...defaultSearchApiDeps(deps.asOf),
    ...deps,
  };

  const { asOf, discovery, port, policy } = resolvedDeps;

  // Derive a stable requestId from the request + asOf.
  const requestId = stableSearchId(request, asOf);
  const searchId = requestId;

  // Build the route discovery request.
  const discoveryRequest = toRouteDiscoveryRequest(request, requestId);

  // Discover route candidates (offline default = synthetic).
  const candidates = await discovery.discover(discoveryRequest);

  // Plan verification jobs.
  const plan = planVerificationJobs(discoveryRequest, candidates, {
    asOf,
    maxCandidateAgeMs: policy.maxCandidateAgeMs,
    maxCandidates: policy.maxCandidates,
    maxLegsPerCandidate: policy.maxLegsPerCandidate,
    maxJobs: policy.maxJobs,
  });

  // Build trusted execution context, initial ledger, and orchestration policy.
  const context = buildTrustedExecutionContext(request, requestId, asOf, policy);
  const ledger = buildInitialLedger(requestId);
  const orchPolicy = buildOrchestrationPolicy(policy, asOf, request.currency);

  // Run the pipeline.
  const result = await runProviderOrchestration(
    { plan, context, ledger, policy: orchPolicy },
    port,
  );

  // Project result to SearchResponse. Real discovery/planning counts are threaded in
  // from here (they are not part of OrchestrationResult) so coverage is honest.
  return toSearchResponse(result, request, asOf, searchId, {
    candidatesDiscovered: candidates.length,
    jobsPlanned: plan.jobs.length,
  });
}
