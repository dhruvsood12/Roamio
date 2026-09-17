import { describe, expect, it } from "vitest";
import { FlightOfferSchema, ItinerarySchema, type Itinerary } from "@flightbrain/domain";
import { durationMinutes, journeyDurationMinutes, metricsFor, rankOffers } from "@flightbrain/ranking";
import { connectingRoundTrip, offerWithJourneys } from "./fixtures/journeys";

describe("C001.1 journey and ranking regressions", () => {
  it("measures the connecting round trip as 900 + 840 minutes and two connections", () => {
    const offer = FlightOfferSchema.parse(offerWithJourneys(connectingRoundTrip()));
    expect(offer.journeys.map(journeyDurationMinutes)).toEqual([900, 840]);
    expect(durationMinutes(offer)).toBe(1740);
    expect(metricsFor(offer)).toMatchObject({ durationMinutes: 1740, stops: 2 });
    expect(rankOffers([offer])[0].metrics).toMatchObject({ durationMinutes: 1740, stops: 2 });
    expect(offer.warnings).toEqual([]);
  });

  it("preserves one-way metrics", () => {
    const [outbound] = connectingRoundTrip();
    expect(metricsFor(FlightOfferSchema.parse(offerWithJourneys([outbound]))))
      .toMatchObject({ durationMinutes: 900, stops: 1 });
    expect(metricsFor(FlightOfferSchema.parse(offerWithJourneys([{ segments: [outbound.segments[0]] }]))))
      .toMatchObject({ durationMinutes: 120, stops: 0 });
  });

  it("counts no connection between the two flights of a direct round trip", () => {
    const [outbound, inbound] = connectingRoundTrip();
    const journeys: Itinerary["journeys"] = [
      { segments: [{ ...outbound.segments[0], destination: "SAN", arrivalAt: "2026-10-10T21:00:00Z" }] },
      { segments: [{ ...inbound.segments[0], destination: "ARN", arrivalAt: "2026-10-20T20:00:00Z" }] },
    ];
    const offer = FlightOfferSchema.parse(offerWithJourneys(journeys));
    expect(offer.journeys.map(journeyDurationMinutes)).toEqual([900, 840]);
    expect(metricsFor(offer)).toMatchObject({ durationMinutes: 1740, stops: 0 });
  });

  it("does not treat an open-jaw destination stay as an airport-change connection", () => {
    const journeys = connectingRoundTrip();
    journeys[1].segments[0].origin = "LAX";
    const offer = FlightOfferSchema.parse(offerWithJourneys(journeys));
    expect(offer.warnings).toEqual([]);
    expect(metricsFor(offer)).toMatchObject({ durationMinutes: 1740, stops: 2 });
    expect(offer.journeys[1].segments[0].origin).toBe("LAX");
  });

  it("leaves travel metrics unchanged when the destination stay grows", () => {
    const journeys = connectingRoundTrip();
    const original = metricsFor(offerWithJourneys(journeys));
    for (const segment of journeys[1].segments) {
      segment.departureAt = segment.departureAt.replace("2026-10-20", "2026-11-20");
      segment.arrivalAt = segment.arrivalAt.replace("2026-10-20", "2026-11-20");
    }
    expect(metricsFor(FlightOfferSchema.parse(offerWithJourneys(journeys)))).toEqual(original);
  });

  it("represents three journeys without turning their boundaries into connections", () => {
    const journeys = connectingRoundTrip();
    journeys.push({ segments: [{
      ...journeys[0].segments[0], origin: "ARN", destination: "CPH",
      departureAt: "2026-10-25T06:00:00Z", arrivalAt: "2026-10-25T07:00:00Z",
      marketingFlightNumber: "104", operatingFlightNumber: "104",
    }] });
    expect(ItinerarySchema.parse({ journeys }).journeys).toHaveLength(3);
    const offer = FlightOfferSchema.parse(offerWithJourneys(journeys));
    expect(offer.journeys.map(journeyDurationMinutes)).toEqual([900, 840, 60]);
    expect(metricsFor(offer)).toMatchObject({ durationMinutes: 1800, stops: 2 });
  });

  it.each([
    { name: "overnight connection", depart: "2026-10-11T01:00:00Z", arrive: "2026-10-11T13:00:00Z", minutes: 1860 },
    { name: "long stopover", depart: "2026-10-20T09:00:00Z", arrive: "2026-10-20T21:00:00Z", minutes: 15300 },
  ])("includes the $name inside an explicitly single journey", ({ depart, arrive, minutes }) => {
    const [journey] = connectingRoundTrip();
    journey.segments[1].departureAt = depart;
    journey.segments[1].arrivalAt = arrive;
    const offer = FlightOfferSchema.parse(offerWithJourneys([journey]));
    expect(offer.journeys).toHaveLength(1);
    expect(metricsFor(offer)).toMatchObject({ durationMinutes: minutes, stops: 1 });
  });

  it("requires airport-change disclosure for a connection inside a later journey", () => {
    const journeys = connectingRoundTrip();
    journeys[1].segments[1].origin = "LGW";
    const raw = offerWithJourneys(journeys);
    const parsed = FlightOfferSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.path)).toContainEqual(["warnings"]);
    const disclosed = FlightOfferSchema.parse({ ...raw, warnings: ["airport_change"] });
    expect(disclosed.warnings).toEqual(["airport_change"]);
    expect(metricsFor(disclosed).stops).toBe(2);
  });

  it("preserves C001's offer-wide mixed-cabin rule across the new nesting", () => {
    const journeys = connectingRoundTrip();
    for (const segment of journeys[1].segments) segment.cabin = "business";
    const raw = offerWithJourneys(journeys);
    expect(FlightOfferSchema.safeParse(raw).success).toBe(false);
    expect(FlightOfferSchema.parse({ ...raw, warnings: ["mixed_cabin"] }).warnings).toEqual(["mixed_cabin"]);
  });

  it("compares offset-aware instants within each journey", () => {
    const journeys = connectingRoundTrip();
    journeys[0].segments[0].departureAt = "2026-10-10T08:00:00+02:00";
    journeys[1].segments[1].arrivalAt = "2026-10-20T22:00:00+02:00";
    expect(durationMinutes(FlightOfferSchema.parse(offerWithJourneys(journeys)))).toBe(1740);
  });

  it("retains whole-minute rounding per journey and sums those durations", () => {
    const base = connectingRoundTrip()[0].segments[0];
    const journeys: Itinerary["journeys"] = [
      { segments: [{ ...base, departureAt: "2026-10-10T06:00:00Z", arrivalAt: "2026-10-10T06:00:30Z" }] },
      { segments: [{ ...base, departureAt: "2026-10-20T06:00:00Z", arrivalAt: "2026-10-20T06:00:30Z" }] },
    ];
    const offer = FlightOfferSchema.parse(offerWithJourneys(journeys));
    expect(offer.journeys.map(journeyDurationMinutes)).toEqual([1, 1]);
    expect(durationMinutes(offer)).toBe(2);
  });

  it("preserves input journeys, boundaries, and identities during parsing and ranking", () => {
    const input = offerWithJourneys(connectingRoundTrip());
    const before = structuredClone(input);
    const parsed = FlightOfferSchema.parse(input);
    rankOffers([parsed]);
    expect(input).toEqual(before);
    expect(parsed).toEqual(before);
    parsed.journeys[1].segments[0].operatingFlightNumber = null;
    expect(input).toEqual(before);
  });
});
