import { describe, expect, it } from "vitest";
import { FlightOfferSchema, SearchRequestSchema, type FlightOffer } from "@flightbrain/domain";
import { groupOffersByItinerary, itineraryFingerprint, searchAll } from "@flightbrain/orchestrator";
import type { FlightProvider } from "@flightbrain/providers";
import { connectingRoundTrip, offerWithJourneys } from "./fixtures/journeys";

// Local test stub only; provider execution behavior is unchanged by C002.
function stub(offers: FlightOffer[], id = "fixture"): FlightProvider {
  return {
    id,
    capabilities: { cashSearch: true, awardSearch: false, revalidation: false, booking: false, flexibleDates: false },
    search: async () => offers,
  };
}

const request = SearchRequestSchema.parse({
  origins: ["ARN"], destinations: ["SAN"], departureDate: "2026-10-10", returnDate: "2026-10-20", cabins: ["economy"],
});

describe("orchestrator Schedule Fingerprint V1 integration", () => {
  it("preserves journey boundaries rather than flattening the same segments", () => {
    const [outbound, inbound] = connectingRoundTrip();
    const separated = offerWithJourneys([outbound, inbound]);
    const flattened = offerWithJourneys([{ segments: [...outbound.segments, ...inbound.segments] }]);
    expect(itineraryFingerprint(separated)).not.toBeNull();
    expect(itineraryFingerprint(separated)).not.toBe(itineraryFingerprint(flattened));
    expect(itineraryFingerprint(separated)).not.toBe(itineraryFingerprint(offerWithJourneys([inbound, outbound])));
  });

  it("uses the explicit operating flight number, not the marketed identity", () => {
    const a = offerWithJourneys(connectingRoundTrip());
    Object.assign(a.journeys[0].segments[0], {
      marketingCarrier: "BA", marketingFlightNumber: "123", operatingCarrier: "AA", operatingFlightNumber: "456",
    });
    const b = structuredClone(a);
    Object.assign(b.journeys[0].segments[0], { marketingCarrier: "AA", marketingFlightNumber: "456" });
    expect(itineraryFingerprint(a)).toBe(itineraryFingerprint(b));
    b.journeys[0].segments[0].operatingFlightNumber = "789";
    expect(itineraryFingerprint(a)).not.toBe(itineraryFingerprint(b));
  });

  it.each([
    { journey: 0, field: "operatingCarrier" as const },
    { journey: 0, field: "operatingFlightNumber" as const },
    { journey: 1, field: "operatingCarrier" as const },
    { journey: 1, field: "operatingFlightNumber" as const },
  ])("returns no identity for unknown $field in journey $journey", ({ journey, field }) => {
    const offer = offerWithJourneys(connectingRoundTrip());
    offer.journeys[journey].segments[1][field] = null;
    expect(FlightOfferSchema.safeParse(offer).success).toBe(true);
    expect(itineraryFingerprint(offer)).toBeNull();
  });

  it("does not conflate identifier text with structural separators", () => {
    const [journey] = connectingRoundTrip();
    const two = offerWithJourneys([journey]);
    const one = offerWithJourneys([{ segments: [{
      ...journey.segments[0], operatingFlightNumber: '100|LHR~SAN~2026-10-10T09:00:00Z~SK~101"]]',
    }] }]);
    expect(FlightOfferSchema.safeParse(one).success).toBe(true);
    expect(itineraryFingerprint(one)).not.toBe(itineraryFingerprint(two));
  });

  it.each(["operatingCarrier", "operatingFlightNumber"])(
    "also avoids a shared key if an unvalidated caller omits %s", (field) => {
      const malformed = offerWithJourneys(connectingRoundTrip());
      // Fault injection: provider-runtime schema enforcement remains outside C002.
      Reflect.deleteProperty(malformed.journeys[0].segments[0], field);
      expect(FlightOfferSchema.safeParse(malformed).success).toBe(false);
      expect(itineraryFingerprint(malformed)).toBeNull();
    },
  );

  it("conservatively keeps conflicting arrival schedules separate", () => {
    const a = offerWithJourneys(connectingRoundTrip());
    const b = structuredClone(a);
    b.journeys[1].segments[1].arrivalAt = "2026-10-20T20:30:00Z";
    expect(itineraryFingerprint(a)).not.toBe(itineraryFingerprint(b));
  });

  it("groups equivalent timestamp spellings by their normalized instant", async () => {
    const a = offerWithJourneys(connectingRoundTrip());
    const b = structuredClone(a);
    b.journeys[0].segments[0].departureAt = "2026-10-10T08:00:00+02:00";
    expect(Date.parse(a.journeys[0].segments[0].departureAt)).toBe(Date.parse(b.journeys[0].segments[0].departureAt));
    expect(itineraryFingerprint(a)).toBe(itineraryFingerprint(b));
    const result = await searchAll(request, [stub([a, b])]);
    expect(result.itineraryGroups).toHaveLength(1);
    expect(result.itineraryGroups[0].offers).toEqual([a, b]);
  });

  it("keeps every unknown-identity offer separate even when IDs repeat", async () => {
    const a = offerWithJourneys(connectingRoundTrip());
    a.journeys[0].segments[0].operatingCarrier = null;
    a.journeys[0].segments[0].operatingFlightNumber = null;
    const b = structuredClone(a);
    b.totalPrice.amountMinor = "60000";
    const c = { ...structuredClone(a), provider: "other-fixture" };
    const before = structuredClone([a, b, c]);
    const result = await searchAll(request, [stub([a, b]), stub([c], "other-fixture")]);
    expect(result.itineraryGroups).toHaveLength(3);
    expect(result.itineraryGroups.map((group) => group.scheduleFingerprint)).toEqual([null, null, null]);
    expect(result.itineraryGroups.map((group) => group.offers)).toEqual([[a], [b], [c]]);
    expect(result.rankedOffers).toHaveLength(3);
    expect([a, b, c]).toEqual(before);
  });

  it("does not group unknown operating identity with the marketed flight's known identity", async () => {
    const known = offerWithJourneys(connectingRoundTrip());
    const unknown = structuredClone(known);
    unknown.journeys[0].segments[0].operatingFlightNumber = null;
    const result = await searchAll(request, [stub([known, unknown])]);
    expect(result.itineraryGroups).toHaveLength(2);
    expect(result.itineraryGroups[0].scheduleFingerprint).toMatch(/^fb:schedule:v1:[0-9a-f]{64}$/);
    expect(result.itineraryGroups[1].scheduleFingerprint).toBeNull();
    expect(unknown.journeys[0].segments[0].operatingFlightNumber).toBeNull();
  });

  it("retains distinct source/fare offers beneath an exact known schedule", async () => {
    const a = offerWithJourneys(connectingRoundTrip());
    const b: FlightOffer = { ...structuredClone(a), provider: "other-fixture", fareBrand: "Synthetic business fare",
      totalPrice: { amountMinor: "70000", currency: "USD", exponent: 2 } };
    for (const journey of b.journeys) for (const segment of journey.segments) segment.cabin = "business";
    expect(FlightOfferSchema.safeParse(b).success).toBe(true);
    const before = structuredClone([a, b]);
    const result = await searchAll(request, [stub([a]), stub([b], "other-fixture")]);
    expect(result.itineraryGroups).toHaveLength(1);
    expect(result.itineraryGroups[0].offers).toEqual([a, b]);
    expect(result.itineraryGroups[0].rankedOffers).toHaveLength(2);
    expect([a, b]).toEqual(before);
  });

  it("uses the pure grouping contract under either provider order", async () => {
    const a = offerWithJourneys(connectingRoundTrip());
    const b: FlightOffer = { ...structuredClone(a), provider: "other-fixture", totalPrice: { amountMinor: "56300", currency: "USD", exponent: 2 } };
    const unknown = structuredClone(b);
    unknown.journeys[1].segments[1].operatingFlightNumber = null;
    const forward = await searchAll(request, [stub([a]), stub([b, unknown], "other-fixture")]);
    const reverse = await searchAll(request, [stub([b, unknown], "other-fixture"), stub([a])]);
    const unranked = (result: typeof forward) => result.itineraryGroups.map(({ rankedOffers, ...group }) => {
      expect(rankedOffers).toHaveLength(group.offers.length);
      expect(group).not.toHaveProperty("fingerprint");
      return group;
    });
    expect(unranked(forward)).toEqual(groupOffersByItinerary([a, b, unknown]));
    expect(unranked(reverse)).toEqual(groupOffersByItinerary([b, unknown, a]));
    expect(reverse.itineraryGroups[0].scheduleFingerprint).toBe(forward.itineraryGroups[0].scheduleFingerprint);
  });
});
