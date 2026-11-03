import {
  SearchRequestSchema,
  type FlightOffer,
  type SearchRequest,
  type SupportedCurrencyCode,
} from "@flightbrain/domain";
import { type FlightProvider, type ProviderCapabilities } from "./index";
import {
  MOCK_PROVIDER_CORPUS,
  ProviderErrorScenarioError,
  type MockProviderScenario,
  type ScenarioConfig,
} from "./fixtures/corpus";

export type { MockProviderScenario };
export { MOCK_PROVIDER_CORPUS, ProviderErrorScenarioError };

export interface MockProviderPolicy {
  /** RFC 3339 timestamp used as "now" for all timestamps. Never the wall clock. */
  asOf: string;
  /** PRNG seed — same seed + same request = same offers. */
  seed: number;
  /** Which scenarios to include in search results. */
  scenarios: MockProviderScenario[];
  /** Currency for all synthesized offers. */
  currency: SupportedCurrencyCode;
  /** How long (ms) offers are valid after asOf. 0 = no expiry. */
  offerValidityMs: number;
  /** Optional simulated latency in ms (uses AbortSignal — not a real delay). */
  latencyMs?: number;
}

export interface MockProviderConfig {
  /** Must match /^mock:/ */
  id: string;
  capabilities: ProviderCapabilities;
  policy: MockProviderPolicy;
}

/** Named error thrown when the timeout scenario aborts via AbortSignal. */
export class MockProviderAbortError extends Error {
  constructor(message = "Mock provider aborted (timeout scenario)") {
    super(message);
    this.name = "MockProviderAbortError";
  }
}

/**
 * Create a deterministic, offline FlightProvider.
 * search() synthesizes offers from the corpus based on the SearchRequest + policy.
 * No network, no wall clock, no stdlib randomness — all timestamps derive from policy.asOf.
 */
export function createMockFlightProvider(config: MockProviderConfig): FlightProvider {
  // Validate id format
  if (!/^mock:/.test(config.id)) {
    throw new Error(`MockProvider id must match /^mock:/ — got: ${config.id}`);
  }

  return {
    id: config.id,
    capabilities: config.capabilities,

    async search(rawRequest: SearchRequest, signal: AbortSignal): Promise<FlightOffer[]> {
      // Check abort immediately
      if (signal.aborted) throw new MockProviderAbortError();

      // Parse and clone to prevent mutation
      const request = SearchRequestSchema.parse(structuredClone(rawRequest));

      const { policy } = config;
      const origin = request.origins[0];
      const destination = request.destinations[0];
      const departureDate = request.departureDate;

      const scenarioCfg: ScenarioConfig = {
        providerId: config.id,
        asOf: policy.asOf,
        seed: policy.seed,
        currency: policy.currency,
        offerValidityMs: policy.offerValidityMs,
        origin,
        destination,
        departureDate,
        capabilities: config.capabilities,
      };

      const allOffers: FlightOffer[] = [];

      for (const scenario of policy.scenarios) {
        // Check abort before each scenario
        if (signal.aborted) throw new MockProviderAbortError();

        if (scenario === "timeout") {
          // The timeout scenario rejects by listening to the AbortSignal.
          // We wait for abort (or immediate if already aborted).
          await new Promise<never>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new MockProviderAbortError());
              return;
            }
            const onAbort = () => {
              signal.removeEventListener("abort", onAbort);
              reject(new MockProviderAbortError());
            };
            signal.addEventListener("abort", onAbort);
          });
          // If we get here (signal was aborted), throw
          throw new MockProviderAbortError();
        }

        if (scenario === "provider_error") {
          throw new ProviderErrorScenarioError("Synthetic provider error — scenario: provider_error");
        }

        if (scenario === "no_results") {
          // contributes nothing — empty
          continue;
        }

        const builder = MOCK_PROVIDER_CORPUS[scenario];
        const offers = builder(scenarioCfg);

        // Filter offers to match request constraints
        for (const offer of offers) {
          if (offerMatchesRequest(offer, request)) {
            allOffers.push(offer);
          }
        }
      }

      return allOffers;
    },
  };
}

/**
 * Check if a synthesized offer is consistent with the search request.
 * - endpoints: offer journey[0] origin must be in request.origins; last segment dest in request.destinations
 * - cabins: all offer cabins must be in requested cabins (except mixed_cabin scenario — has mixed cabins)
 * - maxStops: total stops across all journeys
 * - currency: offer currency matches request.currency (we always set it from policy.currency which is set from request)
 */
function offerMatchesRequest(offer: FlightOffer, request: SearchRequest): boolean {
  // Check origin/destination endpoints
  const firstJourney = offer.journeys[0];
  const firstSegment = firstJourney.segments[0];
  const lastSegment = firstJourney.segments[firstJourney.segments.length - 1];

  if (!request.origins.includes(firstSegment.origin)) return false;
  if (!request.destinations.includes(lastSegment.destination)) return false;

  // Check maxStops: total segments - 1 per journey (simplification: check first journey)
  const stopsInFirstJourney = firstJourney.segments.length - 1;
  if (stopsInFirstJourney > request.maxStops) return false;

  // Check cabins (skip if offer has mixed_cabin warning — it intentionally breaks the constraint)
  if (!offer.warnings.includes("mixed_cabin")) {
    for (const journey of offer.journeys) {
      for (const seg of journey.segments) {
        if (!request.cabins.includes(seg.cabin)) return false;
      }
    }
  }

  // Currency must match request
  if (offer.totalPrice.currency !== request.currency) return false;

  return true;
}
