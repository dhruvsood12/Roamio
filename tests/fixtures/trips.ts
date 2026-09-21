import { FlightOfferSchema, type FlightOffer, type PaymentQuote, type Segment, type TripPlan } from "@flightbrain/domain";
import { itineraryFingerprint } from "@flightbrain/orchestrator";
import { offerWithJourneys } from "./journeys";

// Entirely synthetic facts; no live schedules, fares, awards or provider capability claims.
export function tripSegments(): [Segment, Segment, Segment] {
  const common = { marketingCarrier: "ZZ", operatingCarrier: "ZZ", cabin: "economy" as const };
  return [
    { ...common, origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00Z", arrivalAt: "2026-10-10T08:00:00Z", marketingFlightNumber: "101", operatingFlightNumber: "101" },
    { ...common, origin: "NRT", destination: "LAX", departureAt: "2026-10-10T10:00:00Z", arrivalAt: "2026-10-10T20:00:00Z", marketingFlightNumber: "102", operatingFlightNumber: "102" },
    { ...common, origin: "LAX", destination: "SFO", departureAt: "2026-10-10T22:00:00Z", arrivalAt: "2026-10-11T00:00:00Z", marketingFlightNumber: "103", operatingFlightNumber: "103" },
  ];
}
export function syntheticOffer(segments: [Segment, ...Segment[]], id: string): FlightOffer {
  return FlightOfferSchema.parse({ ...offerWithJourneys([{ segments }]), id, providerOfferId: `source-${id}` });
}
export function planFor(offers: [FlightOffer, ...FlightOffer[]], payments?: PaymentQuote[]): TripPlan {
  return {
    id: "ephemeral-trip", sourceOffers: offers,
    bookingComponents: offers.map((offer, i) => ({
      id: `component-${i}`, provider: offer.provider, providerOfferId: offer.providerOfferId, offerId: offer.id,
      sourceOfferIndex: i, scheduleFingerprint: itineraryFingerprint(offer), order: i,
      payment: payments?.[i] ?? { kind: "cash", amount: offer.totalPrice },
    })) as TripPlan["bookingComponents"],
    journeys: [{ requestedOrigin: offers[0].journeys[0].segments[0].origin,
      requestedDestination: offers[offers.length - 1].journeys[0].segments.at(-1)!.destination,
      segments: offers.flatMap((offer, componentIndex) => offer.journeys[0].segments.map((_, segmentIndex) => ({ componentIndex, journeyIndex: 0, segmentIndex }))) as TripPlan["journeys"][0]["segments"] }],
    protectionFacts: [],
  };
}
export function splitPlan(): TripPlan {
  return planFor(tripSegments().map((s, i) => syntheticOffer([s], `offer-${i}`)) as [FlightOffer, ...FlightOffer[]]);
}
export function singlePlan(): TripPlan { return planFor([syntheticOffer(tripSegments(), "one-offer")]); }
