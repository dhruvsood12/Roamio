import { describe, expect, it } from "vitest";
import type { FlightOffer } from "@flightbrain/domain";
import { paretoFrontier, rankOffers } from "@flightbrain/ranking";

function offer(id: string, price: number, depart: string, arrive: string, extraSegment = false): FlightOffer {
  // Matching identities here are deliberate facts of these synthetic fixtures.
  const segments: FlightOffer["journeys"][number]["segments"] = [
    {
      origin: "ARN",
      destination: extraSegment ? "CPH" : "SAN",
      departureAt: depart,
      arrivalAt: extraSegment ? "2026-10-10T10:00:00+02:00" : arrive,
      marketingCarrier: "SK",
      operatingCarrier: "SK",
      marketingFlightNumber: "100",
      operatingFlightNumber: "100",
      cabin: "economy",
    },
  ];
  if (extraSegment) {
    segments.push({
      origin: "CPH",
      destination: "SAN",
      departureAt: "2026-10-10T12:00:00+02:00",
      arrivalAt: arrive,
      marketingCarrier: "SK",
      operatingCarrier: "SK",
      marketingFlightNumber: "200",
      operatingFlightNumber: "200",
      cabin: "economy",
    });
  }
  return {
    id,
    provider: "mock",
    providerOfferId: id,
    journeys: [{ segments }],
    totalPrice: { amount: price, currency: "USD" },
    refundable: null,
    changeable: null,
    checkedBags: null,
    cabinBags: null,
    bookingUrl: null,
    retrievedAt: "2026-09-17T12:00:00+02:00",
    expiresAt: null,
    requiresRevalidation: true,
    warnings: [],
    providerMetadata: {},
  };
}

describe("ranking", () => {
  it("ranks a cheaper and faster offer above a dominated one", () => {
    const a = offer("a", 500, "2026-10-10T08:00:00+02:00", "2026-10-10T20:00:00-07:00");
    const b = offer("b", 650, "2026-10-10T08:00:00+02:00", "2026-10-10T22:00:00-07:00", true);
    expect(paretoFrontier([a, b]).map((x) => x.id)).toEqual(["a"]);
    expect(rankOffers([a, b])[0].offer.id).toBe("a");
  });
});
