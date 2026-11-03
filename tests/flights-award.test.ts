/**
 * Tests for AwardPriceSchema and award-related FlightOffer / TripOption validation.
 * Goal item 13 — domain award-validator test.
 */

import { describe, expect, it } from "vitest";
import {
  AwardPriceSchema,
  FlightOfferSchema,
  TripOptionSchema,
  createTripOption,
  type FlightOffer,
} from "@flightbrain/domain";
import { planFor, tripSegments } from "./fixtures/trips";

// ---------------------------------------------------------------------------
// AwardPriceSchema
// ---------------------------------------------------------------------------

describe("AwardPriceSchema", () => {
  it("accepts a valid awardPrice with no cashComponent", () => {
    const result = AwardPriceSchema.safeParse({
      program: { id: "aeroplan" },
      points: "50000",
      cashComponent: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid awardPrice with a cashComponent", () => {
    const result = AwardPriceSchema.safeParse({
      program: { id: "aeroplan" },
      points: "50000",
      cashComponent: [{ amountMinor: "5000", currency: "USD", exponent: 2 }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative points", () => {
    const result = AwardPriceSchema.safeParse({
      program: { id: "aeroplan" },
      points: "-1",
      cashComponent: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects decimal points", () => {
    const result = AwardPriceSchema.safeParse({
      program: { id: "aeroplan" },
      points: "50000.5",
      cashComponent: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid program id", () => {
    const result = AwardPriceSchema.safeParse({
      program: { id: "AEROPLAN" }, // must be lowercase
      points: "50000",
      cashComponent: [],
    });
    expect(result.success).toBe(false);
  });

  it("requires cashComponent array (not optional)", () => {
    const result = AwardPriceSchema.safeParse({
      program: { id: "aeroplan" },
      points: "50000",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FlightOfferSchema — awardPrice field
// ---------------------------------------------------------------------------

describe("FlightOfferSchema — awardPrice", () => {
  const baseSegment = {
    origin: "DEL",
    destination: "SFO",
    departureAt: "2026-10-10T00:00:00Z",
    arrivalAt: "2026-10-10T08:00:00Z",
    marketingCarrier: "ZZ",
    marketingFlightNumber: "101",
    operatingCarrier: "ZZ",
    operatingFlightNumber: "101",
    cabin: "economy" as const,
  };

  const baseOffer = {
    id: "test-offer",
    provider: "mock",
    providerOfferId: "source-test",
    journeys: [{ segments: [baseSegment] }],
    totalPrice: { amountMinor: "0", currency: "USD", exponent: 2 },
    refundable: null,
    changeable: null,
    checkedBags: null,
    cabinBags: null,
    bookingUrl: null,
    retrievedAt: "2026-09-17T00:00:00Z",
    expiresAt: null,
    requiresRevalidation: false,
    warnings: [],
    providerMetadata: {},
  };

  it("accepts an offer without awardPrice (back-compat)", () => {
    const result = FlightOfferSchema.safeParse(baseOffer);
    expect(result.success).toBe(true);
  });

  it("accepts an offer with awardPrice: null", () => {
    const result = FlightOfferSchema.safeParse({ ...baseOffer, awardPrice: null });
    expect(result.success).toBe(true);
  });

  it("accepts an offer with a valid awardPrice", () => {
    const result = FlightOfferSchema.safeParse({
      ...baseOffer,
      awardPrice: { program: { id: "aeroplan" }, points: "50000", cashComponent: [] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an offer with an invalid awardPrice (bad points)", () => {
    const result = FlightOfferSchema.safeParse({
      ...baseOffer,
      awardPrice: { program: { id: "aeroplan" }, points: "not-a-number", cashComponent: [] },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TripPlanSchema / createTripOption — award provenance
// ---------------------------------------------------------------------------

describe("award provenance in TripPlanSchema", () => {
  function makeBaseSourceOffer(id: string, withAwardPrice: boolean): FlightOffer {
    const segs = tripSegments();
    const seg0 = { ...segs[0], destination: "SFO", departureAt: "2026-10-10T00:00:00Z", arrivalAt: "2026-10-10T08:00:00Z" };
    const offer: FlightOffer = {
      id,
      provider: "mock",
      providerOfferId: `source-${id}`,
      journeys: [{ segments: [seg0] }],
      totalPrice: { amountMinor: "0", currency: "USD", exponent: 2 },
      refundable: null, changeable: null, checkedBags: null, cabinBags: null,
      bookingUrl: null, retrievedAt: "2026-09-17T00:00:00Z", expiresAt: null,
      requiresRevalidation: false, warnings: [], providerMetadata: {},
    };
    if (withAwardPrice) {
      return { ...offer, awardPrice: { program: { id: "aeroplan" }, points: "50000", cashComponent: [] } };
    }
    return offer;
  }

  it("accepts award payment when awardPrice is present and matches exactly", () => {
    const sourceOffer = makeBaseSourceOffer("match-ok", true);
    const payment = { kind: "award" as const, program: { id: "aeroplan" }, points: "50000", taxesAndFees: [] };
    const plan = planFor([sourceOffer], [payment]);
    plan.id = "match-ok-trip";
    expect(() => createTripOption(plan)).not.toThrow();
  });

  it("rejects award payment when program doesn't match awardPrice", () => {
    const sourceOffer = makeBaseSourceOffer("bad-prog", true);
    const payment = { kind: "award" as const, program: { id: "united-mileageplus" }, points: "50000", taxesAndFees: [] };
    const plan = planFor([sourceOffer], [payment]);
    plan.id = "bad-prog-trip";
    expect(() => createTripOption(plan)).toThrow();
  });

  it("rejects award payment when points don't match awardPrice", () => {
    const sourceOffer = makeBaseSourceOffer("bad-pts", true);
    const payment = { kind: "award" as const, program: { id: "aeroplan" }, points: "99999", taxesAndFees: [] };
    const plan = planFor([sourceOffer], [payment]);
    plan.id = "bad-pts-trip";
    expect(() => createTripOption(plan)).toThrow();
  });

  it("rejects award payment when taxesAndFees don't match awardPrice.cashComponent", () => {
    const sourceOffer = makeBaseSourceOffer("bad-fees", true);
    // awardPrice has empty cashComponent, payment has fees
    const payment = {
      kind: "award" as const,
      program: { id: "aeroplan" }, points: "50000",
      taxesAndFees: [{ amountMinor: "1000", currency: "USD" as const, exponent: 2 }],
    };
    const plan = planFor([sourceOffer], [payment]);
    plan.id = "bad-fees-trip";
    expect(() => createTripOption(plan)).toThrow();
  });

  it("accepts cash payment on offer without awardPrice (back-compat)", () => {
    const sourceOffer = makeBaseSourceOffer("cash-no-award", false);
    // Override totalPrice for cash payment
    sourceOffer.totalPrice = { amountMinor: "50000", currency: "USD", exponent: 2 };
    const payment = { kind: "cash" as const, amount: { amountMinor: "50000", currency: "USD" as const, exponent: 2 } };
    const plan = planFor([sourceOffer], [payment]);
    plan.id = "cash-back-compat-trip";
    expect(() => createTripOption(plan)).not.toThrow();
  });

  it("accepts award payment when awardPrice is absent (back-compat for existing flows)", () => {
    const sourceOffer = makeBaseSourceOffer("award-no-price", false);
    const payment = { kind: "award" as const, program: { id: "aeroplan" }, points: "50000", taxesAndFees: [] };
    const plan = planFor([sourceOffer], [payment]);
    plan.id = "award-no-awardprice-trip";
    // Back-compat: no awardPrice on source → validation skipped
    expect(() => createTripOption(plan)).not.toThrow();
  });

  it("awardPrice is carried through tripSourceSnapshot", () => {
    const sourceOffer = makeBaseSourceOffer("carry-through", true);
    const payment = { kind: "award" as const, program: { id: "aeroplan" }, points: "50000", taxesAndFees: [] };
    const plan = planFor([sourceOffer], [payment]);
    plan.id = "carry-through-trip";
    const trip = createTripOption(plan);
    expect(trip.sourceOffers[0].awardPrice).toBeDefined();
    expect(trip.sourceOffers[0].awardPrice?.program.id).toBe("aeroplan");
    expect(trip.sourceOffers[0].awardPrice?.points).toBe("50000");
  });

  it("TripOptionSchema round-trips with awardPrice in sourceOffers", () => {
    const sourceOffer = makeBaseSourceOffer("roundtrip", true);
    const payment = { kind: "award" as const, program: { id: "aeroplan" }, points: "50000", taxesAndFees: [] };
    const plan = planFor([sourceOffer], [payment]);
    plan.id = "roundtrip-trip";
    const trip = createTripOption(plan);
    const reparsed = TripOptionSchema.safeParse(JSON.parse(JSON.stringify(trip)));
    expect(reparsed.success).toBe(true);
  });

  it("accepts cash_and_points payment whose cash exactly matches awardPrice.cashComponent", () => {
    const cashComponent = [{ amountMinor: "2500", currency: "USD" as const, exponent: 2 }];
    const segs = tripSegments();
    const seg0 = { ...segs[0], destination: "SFO", departureAt: "2026-10-10T00:00:00Z", arrivalAt: "2026-10-10T08:00:00Z" };
    const sourceOffer: FlightOffer = {
      id: "cap-match",
      provider: "mock",
      providerOfferId: "source-cap-match",
      journeys: [{ segments: [seg0] }],
      totalPrice: { amountMinor: "0", currency: "USD", exponent: 2 },
      refundable: null, changeable: null, checkedBags: null, cabinBags: null,
      bookingUrl: null, retrievedAt: "2026-09-17T00:00:00Z", expiresAt: null,
      requiresRevalidation: false, warnings: [], providerMetadata: {},
      awardPrice: { program: { id: "aeroplan" }, points: "40000", cashComponent },
    };
    const payment = { kind: "cash_and_points" as const, program: { id: "aeroplan" }, points: "40000", cash: cashComponent };
    const plan = planFor([sourceOffer], [payment]);
    plan.id = "cap-match-trip";
    expect(() => createTripOption(plan)).not.toThrow();
  });

  it("rejects cash_and_points payment whose cash disagrees with awardPrice.cashComponent", () => {
    const cashComponent = [{ amountMinor: "2500", currency: "USD" as const, exponent: 2 }];
    const wrongCash = [{ amountMinor: "9999", currency: "USD" as const, exponent: 2 }];
    const segs = tripSegments();
    const seg0 = { ...segs[0], destination: "SFO", departureAt: "2026-10-10T00:00:00Z", arrivalAt: "2026-10-10T08:00:00Z" };
    const sourceOffer: FlightOffer = {
      id: "cap-mismatch",
      provider: "mock",
      providerOfferId: "source-cap-mismatch",
      journeys: [{ segments: [seg0] }],
      totalPrice: { amountMinor: "0", currency: "USD", exponent: 2 },
      refundable: null, changeable: null, checkedBags: null, cabinBags: null,
      bookingUrl: null, retrievedAt: "2026-09-17T00:00:00Z", expiresAt: null,
      requiresRevalidation: false, warnings: [], providerMetadata: {},
      awardPrice: { program: { id: "aeroplan" }, points: "40000", cashComponent },
    };
    // payment has wrong cash amount — must be rejected
    const payment = { kind: "cash_and_points" as const, program: { id: "aeroplan" }, points: "40000", cash: wrongCash };
    const plan = planFor([sourceOffer], [payment]);
    plan.id = "cap-mismatch-trip";
    expect(() => createTripOption(plan)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AwardPrice exported from domain/index
// ---------------------------------------------------------------------------

describe("AwardPrice exported from domain", () => {
  it("AwardPriceSchema is exported from @flightbrain/domain", () => {
    expect(AwardPriceSchema).toBeDefined();
    expect(typeof AwardPriceSchema.safeParse).toBe("function");
  });
});
