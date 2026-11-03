/**
 * C007 search-api — public barrel export.
 *
 * Leaf consumer package; nothing may import @flightbrain/search-api back.
 */

export {
  SearchApiRequestSchema,
  SearchApiPolicySchema,
  toRouteDiscoveryRequest,
  buildTrustedExecutionContext,
  buildInitialLedger,
  buildOrchestrationPolicy,
  type SearchApiRequest,
  type SearchApiPolicy,
} from "./request";

export {
  SearchResponseSchema,
  RankedTripResultSchema,
  SearchCoverageSchema,
  SearchDiagnosticsSchema,
  TripFreshnessSchema,
  toSearchResponse,
  type SearchResponse,
  type RankedTripResult,
  type SearchCoverage,
  type SearchDiagnostics,
  type TripFreshness,
} from "./response";

export {
  handleSearch,
  defaultSearchApiDeps,
  type RouteDiscoverySource,
  type SearchApiDeps,
} from "./handler";
