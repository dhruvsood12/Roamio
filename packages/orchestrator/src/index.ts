import { SearchRequestSchema, type SearchRequest } from "@flightbrain/domain";
import { runProvider, type FlightProvider } from "@flightbrain/providers";
import { paretoFrontier, rankOffers } from "@flightbrain/ranking";
import { groupOffersByItinerary } from "./schedule";

export { groupOffersByItinerary, itineraryFingerprint, type ItineraryGroup, type ScheduleFingerprint } from "./schedule";

export async function searchAll(
  rawRequest: SearchRequest,
  providers: FlightProvider[],
  timeoutMs = 8_000,
) {
  const request = SearchRequestSchema.parse(rawRequest);
  const providerResults = await Promise.all(providers.map((p) => runProvider(p, request, timeoutMs)));
  const offers = providerResults.flatMap((r) => r.offers);

  const itineraryGroups = groupOffersByItinerary(offers);

  return {
    status: providerResults.some((r) => r.status === "success") ? "partial_or_complete" : "failed",
    providerResults,
    itineraryGroups: itineraryGroups.map((group) => ({
      ...group,
      rankedOffers: rankOffers(group.offers),
    })),
    paretoOffers: paretoFrontier(offers),
    rankedOffers: rankOffers(offers),
  };
}
