import type { FlightOffer, Itinerary } from "@flightbrain/domain";

// Synthetic C001.1 regression data, not real schedules or fares. Every matching
// marketing/operating number below is a deliberate known fact of the fixture.
export function connectingRoundTrip(): Itinerary["journeys"] {
  return [
    {
      segments: [
        {
          origin: "ARN", destination: "LHR",
          departureAt: "2026-10-10T06:00:00Z", arrivalAt: "2026-10-10T08:00:00Z",
          marketingCarrier: "SK", marketingFlightNumber: "100",
          operatingCarrier: "SK", operatingFlightNumber: "100", cabin: "economy",
        },
        {
          origin: "LHR", destination: "SAN",
          departureAt: "2026-10-10T09:00:00Z", arrivalAt: "2026-10-10T21:00:00Z",
          marketingCarrier: "SK", marketingFlightNumber: "101",
          operatingCarrier: "SK", operatingFlightNumber: "101", cabin: "economy",
        },
      ],
    },
    {
      segments: [
        {
          origin: "SAN", destination: "LHR",
          departureAt: "2026-10-20T06:00:00Z", arrivalAt: "2026-10-20T17:00:00Z",
          marketingCarrier: "SK", marketingFlightNumber: "102",
          operatingCarrier: "SK", operatingFlightNumber: "102", cabin: "economy",
        },
        {
          origin: "LHR", destination: "ARN",
          departureAt: "2026-10-20T18:00:00Z", arrivalAt: "2026-10-20T20:00:00Z",
          marketingCarrier: "SK", marketingFlightNumber: "103",
          operatingCarrier: "SK", operatingFlightNumber: "103", cabin: "economy",
        },
      ],
    },
  ];
}

export function offerWithJourneys(journeys: Itinerary["journeys"]): FlightOffer {
  return {
    id: "synthetic-offer", provider: "fixture", providerOfferId: "synthetic-source-offer",
    journeys, totalPrice: { amount: 500, currency: "USD" },
    refundable: null, changeable: null, checkedBags: null, cabinBags: null,
    bookingUrl: null, retrievedAt: "2026-09-17T10:00:00Z", expiresAt: null,
    requiresRevalidation: true, warnings: [], providerMetadata: {},
  };
}
