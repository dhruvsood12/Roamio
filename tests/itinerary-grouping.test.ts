import { describe, expect, it } from "vitest";
import { FlightOfferSchema, type FlightOffer } from "@flightbrain/domain";
import { groupOffersByItinerary, itineraryFingerprint } from "@flightbrain/orchestrator";
import { connectingRoundTrip, offerWithJourneys } from "./fixtures/journeys";

function baseOffer(): FlightOffer {
  return FlightOfferSchema.parse(offerWithJourneys(connectingRoundTrip()));
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
}

function permutations<T>(values: T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j))
    .map((rest) => [value, ...rest]));
}

describe("conservative itinerary grouping", () => {
  it("returns no groups for no observations", () => {
    expect(groupOffersByItinerary([])).toEqual([]);
  });

  it("groups the synthetic Duffel BA123/AA456 and Skyscanner AA456/AA456 example without losing either price", () => {
    // Hypothetical observations only, not live fares, schedules or provider capability claims.
    const a = baseOffer();
    a.provider = "duffel";
    a.totalPrice.amount = 581;
    Object.assign(a.journeys[0].segments[0], {
      marketingCarrier: "BA", marketingFlightNumber: "123", operatingCarrier: "AA", operatingFlightNumber: "456",
    });
    const b = structuredClone(a);
    b.provider = "skyscanner";
    b.totalPrice.amount = 563;
    Object.assign(b.journeys[0].segments[0], { marketingCarrier: "AA", marketingFlightNumber: "456" });
    expect(FlightOfferSchema.safeParse(a).success).toBe(true);
    expect(FlightOfferSchema.safeParse(b).success).toBe(true);
    expect(itineraryFingerprint(a)).toBe(itineraryFingerprint(b));
    const groups = groupOffersByItinerary([a, b]);
    expect(groups).toEqual([{ scheduleFingerprint: itineraryFingerprint(a), offers: [a, b] }]);
    expect(groups[0].offers[0]).toBe(a);
    expect(groups[0].offers[1]).toBe(b);
    expect(groups[0].offers.map((offer) => offer.totalPrice.amount)).toEqual([581, 563]);
  });

  const commercialChanges: [string, (offer: FlightOffer) => void][] = [
    ["offer ID", (o) => { o.id = "another-observation"; }],
    ["provider", (o) => { o.provider = "other-fixture"; }],
    ["provider offer ID", (o) => { o.providerOfferId = "another-source-offer"; }],
    ["marketing carrier", (o) => { o.journeys[1].segments[1].marketingCarrier = "BA"; }],
    ["marketing flight number", (o) => { o.journeys[1].segments[1].marketingFlightNumber = "999"; }],
    ["price", (o) => { o.totalPrice.amount = 900; }],
    ["currency", (o) => { o.totalPrice.currency = "JPY"; }],
    ["taxes", (o) => { o.taxes = { amount: 50, currency: "USD" }; }],
    ["fare brand", (o) => { o.fareBrand = "Synthetic flexible fare"; }],
    ["cabin", (o) => { for (const j of o.journeys) for (const s of j.segments) s.cabin = "business"; }],
    ["checked baggage", (o) => { o.checkedBags = 2; }],
    ["cabin baggage", (o) => { o.cabinBags = 1; }],
    ["refundability", (o) => { o.refundable = true; }],
    ["changeability", (o) => { o.changeable = false; }],
    ["booking URL", (o) => { o.bookingUrl = "https://example.test/offers/synthetic"; }],
    ["retrieval timestamp", (o) => { o.retrievedAt = "2026-09-17T11:00:00Z"; }],
    ["expiry", (o) => { o.expiresAt = "2026-09-17T12:00:00Z"; }],
    ["revalidation strategy", (o) => { o.requiresRevalidation = false; }],
    ["warnings", (o) => { o.warnings = ["self_transfer", "fare_conditions_unknown"]; }],
    ["aircraft", (o) => { o.journeys[1].segments[1].aircraft = "Synthetic aircraft"; }],
    ["provider metadata", (o) => { o.providerMetadata = { source: "synthetic", fare: { private: true } }; }],
  ];
  it.each(commercialChanges)("retains every commercial variant when only %s differs", (_, change) => {
    const a = baseOffer();
    const b = structuredClone(a);
    change(b);
    expect(FlightOfferSchema.safeParse(b).success).toBe(true);
    const groups = groupOffersByItinerary([a, b]);
    expect(groups).toEqual([{ scheduleFingerprint: itineraryFingerprint(a), offers: [a, b] }]);
    expect(groups[0].offers[0]).toBe(a);
    expect(groups[0].offers[1]).toBe(b);
  });

  it("retains duplicate occurrences with known identity without observation deduplication", () => {
    const offer = baseOffer();
    const sameIds = structuredClone(offer);
    sameIds.totalPrice.amount = 1000;
    const groups = groupOffersByItinerary([offer, offer, sameIds]);
    expect(groups).toHaveLength(1);
    expect(groups[0].offers).toEqual([offer, offer, sameIds]);
    expect(groups[0].offers[0]).toBe(groups[0].offers[1]);
  });

  it("creates a singleton for each null identity, even the same object repeated", () => {
    const unknown = baseOffer();
    unknown.journeys[1].segments[1].operatingFlightNumber = null;
    const clone = structuredClone(unknown);
    const groups = groupOffersByItinerary([unknown, unknown, clone]);
    expect(groups).toEqual([
      { scheduleFingerprint: null, offers: [unknown] },
      { scheduleFingerprint: null, offers: [unknown] },
      { scheduleFingerprint: null, offers: [clone] },
    ]);
    expect(groups[0]).not.toBe(groups[1]);
    expect(groups[0].offers).not.toBe(groups[1].offers);
    expect(groups[0].offers[0]).toBe(groups[1].offers[0]);
  });

  it("keeps known and unknown operating identities separate in either encounter order", () => {
    const known = baseOffer();
    const unknown = structuredClone(known);
    unknown.journeys[0].segments[0].operatingCarrier = null;
    for (const offers of [[known, unknown], [unknown, known]]) {
      const groups = groupOffersByItinerary(offers);
      expect(groups).toHaveLength(2);
      expect(groups.find((g) => g.scheduleFingerprint !== null)?.offers).toEqual([known]);
      expect(groups.find((g) => g.scheduleFingerprint === null)?.offers).toEqual([unknown]);
    }
  });

  it("produces identical membership under every ordering of known and unknown observations", () => {
    const a = baseOffer();
    const sameSchedule = structuredClone(a);
    sameSchedule.provider = "other-fixture";
    sameSchedule.totalPrice.amount = 600;
    const differentSchedule = structuredClone(a);
    differentSchedule.journeys[1].segments[1].operatingFlightNumber = "999";
    const unknown = structuredClone(a);
    unknown.journeys[0].segments[0].operatingFlightNumber = null;
    const observations = [a, sameSchedule, differentSchedule, unknown];
    // Compare multisets of reference identities; ordering has no equality meaning.
    const membership = (offers: FlightOffer[]) => groupOffersByItinerary(offers).map((group) => JSON.stringify({
      scheduleFingerprint: group.scheduleFingerprint,
      offers: group.offers.map((offer) => observations.indexOf(offer)).sort(),
    })).sort();
    const expected = membership(observations);
    for (const reordered of permutations(observations)) expect(membership(reordered)).toEqual(expected);
  });

  it("preserves first-encounter group order and input order within groups", () => {
    const a = baseOffer();
    const b = structuredClone(a);
    b.journeys[0].segments[0].operatingFlightNumber = "999";
    const cheaperA = structuredClone(a);
    cheaperA.totalPrice.amount = 100;
    const unknown = structuredClone(a);
    unknown.journeys[0].segments[0].operatingFlightNumber = null;
    expect(groupOffersByItinerary([b, a, unknown, cheaperA, b, unknown])).toEqual([
      { scheduleFingerprint: itineraryFingerprint(b), offers: [b, b] },
      { scheduleFingerprint: itineraryFingerprint(a), offers: [a, cheaperA] },
      { scheduleFingerprint: null, offers: [unknown] },
      { scheduleFingerprint: null, offers: [unknown] },
    ]);
  });

  it("never mutates deeply frozen offers, arrays, journeys, identities or timestamps", () => {
    const a = baseOffer();
    a.journeys[0].segments[0].departureAt = "2026-10-10T08:00:00+02:00";
    const b = structuredClone(a);
    b.provider = "other-fixture";
    b.journeys[0].segments[0].departureAt = "2026-10-10T06:00:00.000Z";
    const unknown = structuredClone(a);
    unknown.journeys[1].segments[1].operatingFlightNumber = null;
    const offers = [a, b, unknown];
    const before = structuredClone(offers);
    deepFreeze(offers);
    expect(itineraryFingerprint(a)).toBe(itineraryFingerprint(b));
    const first = groupOffersByItinerary(offers);
    const second = groupOffersByItinerary(offers);
    expect(first).toEqual(second);
    expect(first[0].offers).not.toBe(second[0].offers);
    expect(first[0].offers[0]).toBe(a);
    expect(first[0].offers[1]).toBe(b);
    expect(first[1].offers[0]).toBe(unknown);
    first[0].offers.pop();
    expect(second[0].offers).toHaveLength(2);
    expect(offers).toEqual(before);
  });
});
