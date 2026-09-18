import { describe, expect, it } from "vitest";
import { FlightOfferSchema, SearchRequestSchema, type FlightOffer, type Money } from "@flightbrain/domain";
import { groupOffersByItinerary, itineraryFingerprint, searchAll } from "@flightbrain/orchestrator";
import type { FlightProvider } from "@flightbrain/providers";
import { dominates, metricsFor, paretoFrontier, rankOffers } from "@flightbrain/ranking";
import { connectingRoundTrip, offerWithJourneys } from "./fixtures/journeys";

const usd = (amountMinor: string): Money => ({ amountMinor, currency: "USD", exponent: 2 });
function offer(price: Money, id = "synthetic"): FlightOffer {
  return FlightOfferSchema.parse({ ...offerWithJourneys(connectingRoundTrip()), id, totalPrice: price });
}

describe("ranking's exact-money compatibility", () => {
  it.each([["2", "10"], ["9007199254740992", "9007199254740993"],
    ["99999999999999999999999999999999999998", "99999999999999999999999999999999999999"]])(
    "keeps price comparisons and cheapest explanations exact for %s / %s", (low, high) => {
      const cheaper = offer(usd(low), "cheaper");
      const expensive = offer(usd(high), "expensive");
      expect(dominates(metricsFor(cheaper), metricsFor(expensive))).toBe(true);
      expect(dominates(metricsFor(expensive), metricsFor(cheaper))).toBe(false);
      expect(paretoFrontier([expensive, cheaper])).toEqual([cheaper]);
      const ranked = rankOffers([expensive, cheaper]);
      expect(ranked.find((r) => r.offer.id === "cheaper")?.reasons).toContain("Lowest observed price in this result set");
      expect(ranked.find((r) => r.offer.id === "expensive")?.reasons).not.toContain("Lowest observed price in this result set");
    },
  );

  it("preserves the same-currency baseline weights and stable score ties", () => {
    const a = offer(usd("50000"), "a");
    const b = offer(usd("65000"), "b");
    const ranked = rankOffers([b, a]);
    // Both have two connections and equal travel time; old weights remain 50 and 12.
    expect(ranked.map((r) => [r.offer.id, r.score])).toEqual([["a", 76], ["b", 61]]);
    expect(rankOffers([b, { ...b, id: "same-price" }]).map((r) => r.offer.id)).toEqual(["b", "same-price"]);
    const zero = offer(usd("0"), "zero");
    // The starter's zero-minimum policy deliberately remains for C003 to replace.
    expect(rankOffers([a, zero]).map((r) => r.offer.id)).toEqual(["a", "zero"]);
    expect(rankOffers([a, zero]).map((r) => r.score)).toEqual([76, 76]);
  });

  it("retains finite approximate scores over the entire Money range", () => {
    const ranked = rankOffers([offer(usd("1")), offer(usd("99999999999999999999999999999999999999"))]);
    expect(ranked.every((r) => Number.isFinite(r.score))).toBe(true);
    expect(ranked[0].offer.totalPrice).toEqual(usd("1"));
  });

  it.each([
    { amountMinor: "100", currency: "EUR", exponent: 2 },
    { amountMinor: "200", currency: "JPY", exponent: 0 },
    { amountMinor: "100", currency: "KWD", exponent: 3 },
  ] satisfies Money[])("does not compare %j to native USD", (price) => {
    const a = offer(usd("10000"));
    const b = offer(price);
    expect(dominates(metricsFor(a), metricsFor(b))).toBe(false);
    expect(dominates(metricsFor(b), metricsFor(a))).toBe(false);
    expect(paretoFrontier([a, b])).toEqual([a, b]);
    expect(paretoFrontier([b, a])).toEqual([b, a]);
    expect(() => rankOffers([a, b])).toThrow(/different currencies/);
    expect(() => rankOffers([b, a])).toThrow(/different currencies/);
  });

  it("never mutates prices and keeps rank metrics JSON-safe", () => {
    const a = offer(usd("9007199254740993"));
    Object.freeze(a.totalPrice);
    const before = structuredClone(a);
    const ranked = rankOffers([a]);
    expect(ranked[0].metrics.price).toEqual(a.totalPrice);
    expect(JSON.parse(JSON.stringify(ranked))).toEqual(ranked);
    expect(a).toEqual(before);
  });
});

describe("Schedule Fingerprint V1 money exclusion", () => {
  it("retains the C002 golden fingerprint across amounts, currencies, exponents and taxes", () => {
    const prices: Money[] = [usd("0"), usd("9007199254740993"), usd("99999999999999999999999999999999999999"),
      { amountMinor: "500", currency: "JPY", exponent: 0 }, { amountMinor: "1234", currency: "KWD", exponent: 3 }];
    const offers = prices.map((price) => FlightOfferSchema.parse({ ...offer(price), taxes: price }));
    const fingerprint = "fb:schedule:v1:f4e25b498ad038db5cbb6ff5bce300508f95f2862868f91e7663ce866a32a76a";
    expect(offers.map(itineraryFingerprint)).toEqual(prices.map(() => fingerprint));
    expect(groupOffersByItinerary(offers)).toEqual([{ scheduleFingerprint: fingerprint, offers }]);
  });

  it("surfaces mixed-currency ranking incompatibility through the current orchestrator", async () => {
    const offers = [offer(usd("10000")), offer({ amountMinor: "200", currency: "JPY", exponent: 0 })];
    const before = structuredClone(offers);
    const provider: FlightProvider = {
      id: "fixture", capabilities: { cashSearch: true, awardSearch: false, booking: false, revalidation: false, flexibleDates: false },
      search: async () => offers,
    };
    const request = SearchRequestSchema.parse({ origins: ["ARN"], destinations: ["SAN"], departureDate: "2026-10-10", cabins: ["economy"] });
    await expect(searchAll(request, [provider])).rejects.toThrow(/different currencies/);
    expect(offers).toEqual(before);
    expect(groupOffersByItinerary(offers)[0].offers).toEqual(offers);
  });
});
