import { describe, expect, expectTypeOf, it } from "vitest";
import { FlightNumberSchema, FlightOfferSchema, SegmentSchema, type FlightNumber } from "@flightbrain/domain";
import { connectingRoundTrip, offerWithJourneys } from "./fixtures/journeys";

describe("explicit marketing and operating flight identity", () => {
  it("represents BA123 marketed and AA456 operated from two synthetic source layouts", () => {
    // Explicit fixture mappings, not real provider integrations or identity inference.
    const nativeA = { marketing: { carrier: "BA", number: "123" }, operating: { carrier: "AA", number: "456" } };
    const nativeB = { marketing_carrier: "BA", marketing_number: "123", operating_carrier: "AA", operating_number: "456" };
    const base = connectingRoundTrip()[0].segments[0];
    const a = SegmentSchema.parse({ ...base,
      marketingCarrier: nativeA.marketing.carrier, marketingFlightNumber: nativeA.marketing.number,
      operatingCarrier: nativeA.operating.carrier, operatingFlightNumber: nativeA.operating.number,
    });
    const b = SegmentSchema.parse({ ...base,
      marketingCarrier: nativeB.marketing_carrier, marketingFlightNumber: nativeB.marketing_number,
      operatingCarrier: nativeB.operating_carrier, operatingFlightNumber: nativeB.operating_number,
    });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ marketingCarrier: "BA", marketingFlightNumber: "123",
      operatingCarrier: "AA", operatingFlightNumber: "456" });
  });

  it.each([
    { operatingCarrier: null, operatingFlightNumber: null },
    { operatingCarrier: "AA", operatingFlightNumber: null },
    { operatingCarrier: null, operatingFlightNumber: "456" },
  ])("preserves each known/unknown component: $operatingCarrier / $operatingFlightNumber", (identity) => {
    const raw = { ...connectingRoundTrip()[0].segments[0], marketingCarrier: "BA", marketingFlightNumber: "123", ...identity };
    const before = structuredClone(raw);
    expect(SegmentSchema.parse(raw)).toEqual(before);
    const offer = FlightOfferSchema.parse(offerWithJourneys([{ segments: [raw] }]));
    expect(offer.journeys[0].segments[0]).toEqual(before);
    expect(raw).toEqual(before);
  });

  it("does not substitute matching marketing identity when operating identity is explicitly unknown", () => {
    const raw = { ...connectingRoundTrip()[0].segments[0], operatingCarrier: null, operatingFlightNumber: null };
    const parsed = SegmentSchema.parse(raw);
    expect(parsed.marketingCarrier).toBe("SK");
    expect(parsed.marketingFlightNumber).toBe("100");
    expect(parsed.operatingCarrier).toBeNull();
    expect(parsed.operatingFlightNumber).toBeNull();
  });

  it.each(["marketingCarrier", "marketingFlightNumber", "operatingCarrier", "operatingFlightNumber"])(
    "requires explicit %s rather than defaulting from other identity fields", (field) => {
      expect(SegmentSchema.safeParse({ ...connectingRoundTrip()[0].segments[0], [field]: undefined }).success).toBe(false);
    },
  );

  it("rejects the removed ambiguous field even alongside valid explicit identities", () => {
    const raw = connectingRoundTrip()[0].segments[0];
    expect(SegmentSchema.safeParse({ ...raw, flightNumber: "BA123" }).success).toBe(false);
    const { marketingFlightNumber, operatingFlightNumber, ...legacy } = raw;
    expect(SegmentSchema.safeParse({ ...legacy, flightNumber: "BA123" }).success).toBe(false);
    expect(marketingFlightNumber).toBe("100");
    expect(operatingFlightNumber).toBe("100");
  });

  it.each(["123", "00123", "123A"])("preserves source-supported number spelling %s without normalization", (number) => {
    const parsed = FlightNumberSchema.parse(number);
    expect(parsed).toBe(number);
    expectTypeOf(parsed).toEqualTypeOf<FlightNumber>();
  });

  it.each(["", " ", " 123", "123 ", "123\n", "123\u0000", 123, null, undefined])(
    "rejects malformed flight-number values %j", (number) => {
      expect(FlightNumberSchema.safeParse(number).success).toBe(false);
    },
  );
});
