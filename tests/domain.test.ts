import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  FlightOfferSchema,
  ItinerarySchema,
  JourneySchema,
  ProviderObservationSchema,
  ProviderSearchResultSchema,
  SearchRequestSchema,
  SegmentSchema,
  type FlightOffer,
  type Itinerary,
  type Journey,
  type ProviderObservation,
  type ProviderSearchResult,
  type SearchRequest,
} from "@flightbrain/domain";

// Synthetic schema fixtures only: these do not assert real schedules, fares or capabilities.
function segment() {
  return {
    origin: "ARN", destination: "CPH",
    departureAt: "2026-10-10T08:00:00+02:00", arrivalAt: "2026-10-10T09:00:00+02:00",
    // This synthetic flight deliberately has known, matching marketing/operating facts.
    marketingCarrier: "SK", marketingFlightNumber: "100",
    operatingCarrier: "SK", operatingFlightNumber: "100", cabin: "economy",
  } satisfies z.input<typeof SegmentSchema>;
}

function onwardSegment() {
  return {
    ...segment(), origin: "CPH", destination: "SAN", marketingFlightNumber: "200", operatingFlightNumber: "200",
    departureAt: "2026-10-10T10:00:00+02:00", arrivalAt: "2026-10-10T15:00:00-07:00",
  };
}

function observation() {
  return {
    provider: "fixture", providerOfferId: "native-1", bookingUrl: "https://booking.example.invalid/offer/1",
    retrievedAt: "2026-09-17T12:00:00+02:00", expiresAt: "2026-09-17T12:30:00+02:00",
    requiresRevalidation: true,
  } satisfies z.input<typeof ProviderObservationSchema>;
}

function offer() {
  return {
    id: "offer-1", ...observation(), journeys: [{ segments: [segment()] }], totalPrice: { amountMinor: "50000", currency: "USD", exponent: 2 },
    refundable: null, changeable: null, checkedBags: null, cabinBags: null,
  } satisfies z.input<typeof FlightOfferSchema>;
}

function request() {
  return {
    origins: ["ARN"], destinations: ["SAN"], departureDate: "2026-10-10", cabins: ["economy"],
  } satisfies z.input<typeof SearchRequestSchema>;
}

function result() {
  return {
    provider: "fixture", offers: [offer()], startedAt: "2026-09-17T11:59:00+02:00",
    finishedAt: "2026-09-17T12:01:00+02:00", status: "success",
  } satisfies z.input<typeof ProviderSearchResultSchema>;
}

function expectInvalid(schema: z.ZodType, value: unknown, path?: (string | number)[]) {
  const parsed = schema.safeParse(value);
  expect(parsed.success).toBe(false);
  if (!parsed.success && path) {
    expect(parsed.error.issues.map((issue) => issue.path)).toContainEqual(path);
  }
}

describe("SearchRequest", () => {
  it("applies only the existing optional search defaults", () => {
    const parsed = SearchRequestSchema.parse(request());
    expect(parsed).toEqual({ ...request(), adults: 1, maxStops: 1, currency: "USD" });
    expectTypeOf(parsed).toEqualTypeOf<SearchRequest>();
  });

  it("preserves a full round-trip request and multiple airport/cabin preferences", () => {
    const value = { ...request(), origins: ["ARN", "CPH"], destinations: ["SAN", "LAX"],
      returnDate: "2026-10-20", adults: 9, cabins: ["economy", "business"],
      maxStops: 3, currency: "SEK", market: "SE" };
    expect(SearchRequestSchema.parse(value)).toEqual(value);
  });

  it("allows an explicitly null return, same-day return, and zero stops", () => {
    expect(SearchRequestSchema.parse({ ...request(), returnDate: null, maxStops: 0 }).returnDate).toBeNull();
    expect(SearchRequestSchema.parse({ ...request(), returnDate: request().departureDate }).returnDate)
      .toBe(request().departureDate);
  });

  it("does not impose a wall-clock rule on historical search dates", () => {
    expect(SearchRequestSchema.safeParse({ ...request(), departureDate: "2000-02-29" }).success).toBe(true);
  });

  it("rejects return before departure at the correct field", () => {
    expectInvalid(SearchRequestSchema, { ...request(), returnDate: "2026-10-09" }, ["returnDate"]);
  });

  it.each(["origins", "destinations"] as const)("rejects empty, duplicate or malformed %s", (field) => {
    for (const value of [[], ["ARN", "ARN"], ["arn"], [null], "ARN", null, undefined]) {
      expectInvalid(SearchRequestSchema, { ...request(), [field]: value });
    }
  });

  it("rejects any overlap between origin and destination sets", () => {
    expectInvalid(SearchRequestSchema, { ...request(), origins: ["ARN", "CPH"], destinations: ["SAN", "CPH"] }, ["destinations"]);
  });

  it.each([[], ["economy", "economy"], ["Economy"], ["unknown"], [null]].map((cabins) => ({ cabins })))(
    "rejects invalid cabin preferences $cabins", ({ cabins }) => {
      expectInvalid(SearchRequestSchema, { ...request(), cabins });
    },
  );

  it.each([
    ["adults", 0], ["adults", 10], ["adults", 1.5], ["adults", "1"], ["adults", null],
    ["maxStops", -1], ["maxStops", 4], ["maxStops", 0.5], ["maxStops", "0"], ["maxStops", null],
    ["currency", "usd"], ["currency", null], ["market", "se"], ["market", "SWE"], ["market", null],
    ["departureDate", "2026-02-29"], ["departureDate", null], ["departureDate", undefined],
    ["returnDate", "2026-04-31"], ["returnDate", "2026-10-11T00:00:00Z"],
    ["cabins", "economy"], ["cabins", null], ["cabins", undefined],
  ])("rejects malformed %s=%j instead of coercing or defaulting it", (field, value) => {
    expectInvalid(SearchRequestSchema, { ...request(), [field as string]: value }, [field as string]);
  });

  it("rejects unmodeled passenger categories and misspelled keys", () => {
    expectInvalid(SearchRequestSchema, { ...request(), children: 1 });
    expectInvalid(SearchRequestSchema, { ...request(), maxStop: 0 });
  });
});

describe("Segment", () => {
  it("preserves a segment, optional aircraft and codeshare carriers", () => {
    const value = { ...segment(), aircraft: "A320", marketingCarrier: "BA", marketingFlightNumber: "100A",
      operatingCarrier: "AA", operatingFlightNumber: "456" };
    expect(SegmentSchema.parse(value)).toEqual(value);
    expect(SegmentSchema.parse({ ...segment(), aircraft: null }).aircraft).toBeNull();
    expect(SegmentSchema.parse(segment())).not.toHaveProperty("aircraft");
  });

  it("compares instants even when local arrival looks earlier", () => {
    const value = { ...segment(), departureAt: "2026-10-10T10:00:00+02:00", arrivalAt: "2026-10-10T09:30:00Z" };
    expect(SegmentSchema.parse(value)).toEqual(value);
  });

  it("handles an international date-line crossing", () => {
    const value = { ...segment(), departureAt: "2026-10-11T00:30:00+14:00", arrivalAt: "2026-10-10T23:30:00-10:00" };
    expect(SegmentSchema.parse(value)).toEqual(value);
  });

  it("accepts positive elapsed time through a daylight-saving clock rollback", () => {
    expect(SegmentSchema.safeParse({ ...segment(), departureAt: "2026-10-25T02:30:00+02:00",
      arrivalAt: "2026-10-25T02:15:00+01:00" }).success).toBe(true);
  });

  it.each([
    "2026-10-10T08:00:00+02:00", // Identical timestamp.
    "2026-10-10T06:00:00Z", // Same instant with another offset.
    "2026-10-10T07:59:59+02:00",
    "2026-10-10T09:00:00+04:00", // Later local time, earlier instant.
  ])("rejects nonpositive elapsed time: %s", (arrivalAt) => {
    expectInvalid(SegmentSchema, { ...segment(), arrivalAt }, ["arrivalAt"]);
  });

  it("keeps the one-millisecond positive duration boundary", () => {
    expect(SegmentSchema.safeParse({ ...segment(), departureAt: "2026-10-10T06:00:00.000Z",
      arrivalAt: "2026-10-10T06:00:00.001Z" }).success).toBe(true);
  });

  it("rejects a segment whose airports are identical", () => {
    expectInvalid(SegmentSchema, { ...segment(), destination: "ARN" }, ["destination"]);
  });

  it.each([
    ["origin", "arn"], ["origin", null], ["destination", "123"], ["marketingCarrier", "s!"],
    ["operatingCarrier", ""], ["operatingCarrier", 123], ["marketingCarrier", null],
    ["marketingFlightNumber", ""], ["marketingFlightNumber", " "], ["marketingFlightNumber", null],
    ["marketingFlightNumber", "100\n"], ["marketingFlightNumber", 100],
    ["operatingFlightNumber", ""], ["operatingFlightNumber", " "],
    ["operatingFlightNumber", "456\n"], ["operatingFlightNumber", 456], ["cabin", "BUSINESS"], ["cabin", null],
    ["aircraft", ""], ["aircraft", " A320"], ["departureAt", "2026-10-10T08:00:00"],
    ["arrivalAt", "2026-02-29T09:00:00Z"],
  ])("rejects malformed segment %s=%j", (field, value) => {
    expectInvalid(SegmentSchema, { ...segment(), [field as string]: value }, [field as string]);
  });

  it.each(["origin", "destination", "departureAt", "arrivalAt", "marketingCarrier", "marketingFlightNumber",
    "operatingCarrier", "operatingFlightNumber", "cabin"])(
    "requires %s", (field) => expectInvalid(SegmentSchema, { ...segment(), [field]: undefined }, [field]),
  );

  it("rejects provider-native fields on a segment", () => {
    expectInvalid(SegmentSchema, { ...segment(), nativeSegmentId: "123" });
  });
});

describe("Journey", () => {
  it("accepts a nonstop or chronological connection", () => {
    const nonstop = JourneySchema.parse({ segments: [segment()] });
    expect(nonstop.segments).toEqual([segment()]);
    expectTypeOf(nonstop).toEqualTypeOf<Journey>();
    expectTypeOf(nonstop.segments).toEqualTypeOf<[z.infer<typeof SegmentSchema>, ...z.infer<typeof SegmentSchema>[]]>();
    expect(JourneySchema.parse({ segments: [segment(), onwardSegment()] }).segments).toHaveLength(2);
  });

  it("allows a zero-gap boundary without claiming that the connection is bookable", () => {
    expect(JourneySchema.safeParse({ segments: [segment(), { ...onwardSegment(),
      departureAt: "2026-10-10T07:00:00Z" }] }).success).toBe(true);
  });

  it("preserves airport changes and multi-day gaps without inventing transfer protection", () => {
    const segments = [segment(), { ...onwardSegment(), origin: "LHR",
      departureAt: "2026-10-11T10:00:00+02:00", arrivalAt: "2026-10-11T15:00:00-07:00" }];
    expect(JourneySchema.parse({ segments })).toEqual({ segments });
  });

  it.each([[], [null], "ARN-CPH", null, undefined].map((segments) => ({ segments })))("rejects missing or malformed segments $segments", ({ segments }) => {
    expectInvalid(JourneySchema, { segments });
  });

  it("rejects unordered segments instead of silently sorting them", () => {
    const segments = [onwardSegment(), segment()];
    expectInvalid(JourneySchema, { segments }, ["segments", 1, "departureAt"]);
    expect(segments[0]).toEqual(onwardSegment());
  });

  it("rejects an overlap visible only after comparing offsets", () => {
    expectInvalid(JourneySchema, { segments: [segment(), { ...onwardSegment(),
      departureAt: "2026-10-10T10:00:00+04:00" }] }, ["segments", 1, "departureAt"]);
  });

  it("validates every adjacency and rejects duplicate segments", () => {
    expectInvalid(JourneySchema, { segments: [segment(), segment()] }, ["segments", 1, "departureAt"]);
    expectInvalid(JourneySchema, { segments: [segment(), onwardSegment(), {
      ...segment(), origin: "SAN", destination: "LAX", departureAt: "2026-10-10T21:00:00Z",
      arrivalAt: "2026-10-10T23:00:00Z",
    }] }, ["segments", 2, "departureAt"]);
  });

  it("rejects fare/provider fields on the schedule-only contract", () => {
    expectInvalid(JourneySchema, { segments: [segment()], provider: "fixture" });
  });
});

describe("Itinerary", () => {
  it("preserves explicit journey boundaries and nonempty tuple types", () => {
    const value = { journeys: [{ segments: [segment()] }, { segments: [onwardSegment()] }] };
    const parsed = ItinerarySchema.parse(value);
    expect(parsed).toEqual(value);
    expectTypeOf(parsed).toEqualTypeOf<Itinerary>();
    expectTypeOf(parsed.journeys).toEqualTypeOf<[Journey, ...Journey[]]>();
  });

  it.each([[], [null], [{}], [{ segments: [] }], "ARN-CPH", null, undefined].map((journeys) => ({ journeys })))(
    "rejects empty or malformed journeys $journeys", ({ journeys }) => {
      expectInvalid(ItinerarySchema, { journeys });
      expectInvalid(FlightOfferSchema, { ...offer(), journeys });
    },
  );

  it("rejects legacy flat segments and unmodeled fields", () => {
    expectInvalid(ItinerarySchema, { segments: [segment()] });
    expectInvalid(ItinerarySchema, { journeys: [{ segments: [segment()] }], segments: [segment()] });
    expectInvalid(ItinerarySchema, { journeys: [{ segments: [segment()] }], provider: "fixture" });
    expectInvalid(FlightOfferSchema, { ...offer(), segments: [segment()] });
  });

  it("validates segments in every journey with complete error paths", () => {
    const journeys = [{ segments: [segment()] }, { segments: [onwardSegment(), segment()] }];
    expectInvalid(ItinerarySchema, { journeys }, ["journeys", 1, "segments", 1, "departureAt"]);
    expectInvalid(FlightOfferSchema, { ...offer(), journeys }, ["journeys", 1, "segments", 1, "departureAt"]);
  });

  it("does not compare chronology across separate journeys or reorder them", () => {
    const value = { journeys: [{ segments: [onwardSegment()] }, { segments: [segment()] }] };
    const before = structuredClone(value);
    expect(ItinerarySchema.parse(value)).toEqual(before);
    expect(FlightOfferSchema.parse({ ...offer(), ...value }).journeys).toEqual(before.journeys);
    expect(value).toEqual(before);
  });
});

describe("ProviderObservation", () => {
  it("preserves provenance and explicit opaque provider metadata", () => {
    const value = { ...observation(), providerMetadata: { native: { token: "synthetic-token", flag: null }, version: 1 } };
    const parsed = ProviderObservationSchema.parse(value);
    expect(parsed).toEqual(value);
    expectTypeOf(parsed).toEqualTypeOf<ProviderObservation>();
  });

  it("preserves unknown expiry/booking URL and an explicit false revalidation flag", () => {
    const parsed = ProviderObservationSchema.parse({ ...observation(), expiresAt: null, bookingUrl: null, requiresRevalidation: false });
    expect(parsed).toEqual({ ...observation(), expiresAt: null, bookingUrl: null, requiresRevalidation: false, providerMetadata: {} });
  });

  it("accepts historical observations without a wall-clock freshness check", () => {
    expect(ProviderObservationSchema.safeParse({ ...observation(), retrievedAt: "2000-01-01T00:00:00Z",
      expiresAt: "2000-01-01T00:30:00Z" }).success).toBe(true);
  });

  it("compares expiry/retrieval instants instead of timestamp strings", () => {
    expect(ProviderObservationSchema.safeParse({ ...observation(), expiresAt: "2026-09-17T10:00:00.001Z" }).success).toBe(true);
    expectInvalid(ProviderObservationSchema, { ...observation(), expiresAt: "2026-09-17T12:30:00+03:00" }, ["expiresAt"]);
  });

  it.each(["2026-09-17T10:00:00Z", "2026-09-17T09:59:59Z"])("rejects expiry at/before retrieval %s", (expiresAt) => {
    expectInvalid(ProviderObservationSchema, { ...observation(), expiresAt }, ["expiresAt"]);
  });

  it.each(["provider", "providerOfferId", "bookingUrl", "retrievedAt", "expiresAt", "requiresRevalidation"])(
    "requires explicit %s", (field) => expectInvalid(ProviderObservationSchema, { ...observation(), [field]: undefined }, [field]),
  );

  it.each([
    ["provider", ""], ["provider", " "], ["provider", " fixture"], ["providerOfferId", ""],
    ["providerOfferId", "\n"], ["providerOfferId", 1], ["retrievedAt", null],
    ["retrievedAt", "2026-09-17T12:00:00"], ["expiresAt", "not-a-date"],
    ["requiresRevalidation", "true"], ["requiresRevalidation", null],
    ["providerMetadata", []], ["providerMetadata", null], ["providerMetadata", "native payload"],
  ])("rejects malformed provenance %s=%j", (field, value) => {
    expectInvalid(ProviderObservationSchema, { ...observation(), [field as string]: value }, [field as string]);
  });

  it.each([
    "https://booking.example.invalid/offer?id=1&return=%2Fsearch",
    "http://booking.example.invalid/offer/1",
  ])("preserves HTTP(S) redirect %s", (bookingUrl) => {
    expect(ProviderObservationSchema.parse({ ...observation(), bookingUrl }).bookingUrl).toBe(bookingUrl);
  });

  it.each([
    "javascript:alert(1)", "data:text/html,hello", "file:///tmp/booking", "ftp://example.invalid/offer",
    "/offer/1", "//booking.example.invalid/offer", "https:example.invalid", "https://",
    "https://user:password@example.invalid/offer", "https://user@example.invalid/offer",
    " https://example.invalid/offer", "https://example.invalid/a b", "https://example.invalid/\noffer",
    "https://example.invalid\\offer", "https://example.invalid:99999/offer",
    "https:///example.invalid/offer", "https://example.invalid/offer\u0000", "", 123,
  ])("rejects malformed booking URL %j", (bookingUrl) => {
    expectInvalid(ProviderObservationSchema, { ...observation(), bookingUrl }, ["bookingUrl"]);
  });

  it("rejects provider-specific fields outside metadata", () => {
    expectInvalid(ProviderObservationSchema, { ...observation(), nativeSession: "123" });
  });
});

describe("FlightOffer", () => {
  it("keeps fare/provenance fields alongside journeys and applies only collection defaults", () => {
    const parsed = FlightOfferSchema.parse(offer());
    expect(parsed).toEqual({ ...offer(), warnings: [], providerMetadata: {} });
    expectTypeOf(parsed).toEqualTypeOf<FlightOffer>();
    expect(parsed.refundable).toBeNull();
    expect(parsed.checkedBags).toBeNull();
    expect(parsed).not.toHaveProperty("taxes");
    expect(parsed).not.toHaveProperty("fareBrand");
  });

  it("preserves known fare data without replacing false/zero with unknown", () => {
    const value = { ...offer(), refundable: false, changeable: true, checkedBags: 0, cabinBags: 1,
      taxes: { amountMinor: "2550", currency: "USD", exponent: 2 }, fareBrand: "Test Flex" };
    expect(FlightOfferSchema.parse(value)).toMatchObject(value);
  });

  it("accepts null optional fare data without fabricating information", () => {
    expect(FlightOfferSchema.parse({ ...offer(), taxes: null, fareBrand: null, bookingUrl: null, expiresAt: null }))
      .toMatchObject({ taxes: null, fareBrand: null, bookingUrl: null, expiresAt: null });
  });

  it.each(["0", "50000"])("accepts tax amount at the valid boundary %s", (amountMinor) => {
    expect(FlightOfferSchema.safeParse({ ...offer(), taxes: { amountMinor, currency: "USD", exponent: 2 } }).success).toBe(true);
  });

  it("accepts a zero total and zero taxes", () => {
    expect(FlightOfferSchema.safeParse({ ...offer(), totalPrice: { amountMinor: "0", currency: "USD", exponent: 2 },
      taxes: { amountMinor: "0", currency: "USD", exponent: 2 } }).success).toBe(true);
  });

  it("rejects tax currency mismatch and taxes exceeding the inclusive total", () => {
    expectInvalid(FlightOfferSchema, { ...offer(), taxes: { amountMinor: "1000", currency: "EUR", exponent: 2 } }, ["taxes", "currency"]);
    expectInvalid(FlightOfferSchema, { ...offer(), taxes: { amountMinor: "50001", currency: "USD", exponent: 2 } }, ["taxes", "amountMinor"]);
  });

  it("requires mixed-cabin disclosure without silently inserting it", () => {
    const value = { ...offer(), journeys: [{ segments: [segment(), { ...onwardSegment(), cabin: "business" }] }] };
    expectInvalid(FlightOfferSchema, value, ["warnings"]);
    expect(value).not.toHaveProperty("warnings");
    expect(FlightOfferSchema.parse({ ...value, warnings: ["mixed_cabin"] }).warnings).toEqual(["mixed_cabin"]);
  });

  it("requires airport-change disclosure but does not infer self-transfer", () => {
    const value = { ...offer(), journeys: [{ segments: [segment(), { ...onwardSegment(), origin: "LHR" }] }] };
    expectInvalid(FlightOfferSchema, value, ["warnings"]);
    const parsed = FlightOfferSchema.parse({ ...value, warnings: ["airport_change"] });
    expect(parsed.warnings).toEqual(["airport_change"]);
  });

  it("requires all observable warnings when risks are combined", () => {
    const value = { ...offer(), journeys: [{ segments: [segment(), { ...onwardSegment(), origin: "LHR", cabin: "business" }] }] };
    expectInvalid(FlightOfferSchema, { ...value, warnings: ["airport_change"] }, ["warnings"]);
    expect(FlightOfferSchema.parse({ ...value, warnings: ["airport_change", "mixed_cabin", "self_transfer"] }).warnings)
      .toEqual(["airport_change", "mixed_cabin", "self_transfer"]);
  });

  it("preserves provider-reported warnings whose thresholds cannot be inferred", () => {
    const warnings = ["self_transfer", "overnight_layover", "short_connection", "stale_price", "fare_conditions_unknown"];
    expect(FlightOfferSchema.parse({ ...offer(), warnings }).warnings).toEqual(warnings);
  });

  it("rejects duplicate warnings that would inflate ranking penalties", () => {
    expectInvalid(FlightOfferSchema, { ...offer(), warnings: ["stale_price", "stale_price"] }, ["warnings"]);
  });

  it("keeps nested segment, itinerary and observation refinements active", () => {
    expectInvalid(FlightOfferSchema, { ...offer(), journeys: [{ segments: [{ ...segment(), arrivalAt: segment().departureAt }] }] },
      ["journeys", 0, "segments", 0, "arrivalAt"]);
    expectInvalid(FlightOfferSchema, { ...offer(), journeys: [{ segments: [onwardSegment(), segment()] }] },
      ["journeys", 0, "segments", 1, "departureAt"]);
    expectInvalid(FlightOfferSchema, { ...offer(), expiresAt: observation().retrievedAt }, ["expiresAt"]);
  });

  it.each(["id", "provider", "providerOfferId", "journeys", "totalPrice", "retrievedAt", "expiresAt",
    "bookingUrl", "requiresRevalidation", "refundable", "changeable", "checkedBags", "cabinBags"])(
    "requires explicit %s", (field) => expectInvalid(FlightOfferSchema, { ...offer(), [field]: undefined }, [field]),
  );

  it.each([
    ["id", ""], ["id", " "], ["id", "id\u0000"], ["id", 1], ["journeys", []], ["journeys", null],
    ["refundable", "false"], ["changeable", 0], ["checkedBags", -1], ["checkedBags", 0.5],
    ["checkedBags", "1"], ["checkedBags", NaN], ["checkedBags", Infinity],
    ["cabinBags", -1], ["cabinBags", 0.5], ["cabinBags", "0"], ["cabinBags", Infinity],
    ["cabinBags", Number.MAX_SAFE_INTEGER + 1], ["fareBrand", ""], ["fareBrand", "  "],
    ["warnings", null], ["warnings", "stale_price"], ["warnings", ["native_warning"]],
    ["taxes", { amountMinor: 10, currency: "USD", exponent: 2 }], ["totalPrice", { amountMinor: NaN, currency: "USD", exponent: 2 }],
    ["totalPrice", { amountMinor: "-1", currency: "USD", exponent: 2 }],
  ])("rejects malformed provider offer field %s=%j", (field, value) => {
    expectInvalid(FlightOfferSchema, { ...offer(), [field as string]: value });
  });

  it("preserves provider-specific data only inside providerMetadata", () => {
    const native = { privateFare: { seatsRemaining: null, inventoryId: "synthetic-inventory" } };
    expect(FlightOfferSchema.parse({ ...offer(), providerMetadata: native }).providerMetadata).toEqual(native);
    expectInvalid(FlightOfferSchema, { ...offer(), ...native });
    expectInvalid(FlightOfferSchema, { ...offer(), totalPrice: { amountMinor: "50000", currency: "USD", exponent: 2, nativeAmount: "500.00" } });
  });

  it("does not mutate input or share default collections between results", () => {
    const raw = offer();
    const before = structuredClone(raw);
    const first = FlightOfferSchema.parse(raw);
    const second = FlightOfferSchema.parse(raw);
    first.warnings.push("self_transfer");
    first.providerMetadata.nativeId = "synthetic-id";
    first.journeys[0].segments[0].marketingFlightNumber = "changed";
    first.journeys[0].segments[0].operatingFlightNumber = "changed-operating";
    expect(second.warnings).toEqual([]);
    expect(second.providerMetadata).toEqual({});
    expect(second.journeys[0].segments[0].marketingFlightNumber).toBe("100");
    expect(second.journeys[0].segments[0].operatingFlightNumber).toBe("100");
    expect(raw).toEqual(before);
  });
});

describe("ProviderSearchResult", () => {
  it("validates all nested offers and keeps the existing result type", () => {
    const parsed = ProviderSearchResultSchema.parse(result());
    expect(parsed.offers).toEqual([FlightOfferSchema.parse(offer())]);
    expectTypeOf(parsed).toEqualTypeOf<ProviderSearchResult>();
  });

  it("treats zero inventory as success", () => {
    expect(ProviderSearchResultSchema.parse({ ...result(), offers: [] }).status).toBe("success");
  });

  it.each(["error", "timeout"])("accepts %s with no offers and an optional error code", (status) => {
    expect(ProviderSearchResultSchema.parse({ ...result(), offers: [], status }).status).toBe(status);
    expect(ProviderSearchResultSchema.parse({ ...result(), offers: [], status, errorCode: "TEST_FAILURE" }).errorCode)
      .toBe("TEST_FAILURE");
  });

  it.each(["error", "timeout"])("rejects offers reported under %s", (status) => {
    expectInvalid(ProviderSearchResultSchema, { ...result(), status }, ["offers"]);
  });

  it("rejects errors reported under success", () => {
    expectInvalid(ProviderSearchResultSchema, { ...result(), errorCode: "TEST_FAILURE" }, ["errorCode"]);
  });

  it("checks the observation provider for every offer", () => {
    expectInvalid(ProviderSearchResultSchema, { ...result(), offers: [offer(), { ...offer(), id: "offer-2", provider: "different" }] },
      ["offers", 1, "provider"]);
  });

  it("checks result chronology by instant, allowing zero elapsed time", () => {
    expect(ProviderSearchResultSchema.safeParse({ ...result(), finishedAt: "2026-09-17T09:59:00Z" }).success).toBe(true);
    expectInvalid(ProviderSearchResultSchema, { ...result(), finishedAt: "2026-09-17T12:01:00+03:00" }, ["finishedAt"]);
  });

  it("does not reject a cached observation predating the provider call", () => {
    expect(ProviderSearchResultSchema.safeParse({ ...result(), offers: [{ ...offer(), retrievedAt: "2026-09-16T10:00:00Z" }] }).success)
      .toBe(true);
  });

  it.each(["provider", "offers", "startedAt", "finishedAt", "status"])("requires %s", (field) => {
    expectInvalid(ProviderSearchResultSchema, { ...result(), [field]: undefined }, [field]);
  });

  it.each([
    ["provider", " "], ["status", "partial"], ["status", "SUCCESS"], ["errorCode", ""],
    ["offers", null], ["offers", {}], ["offers", [null]], ["startedAt", "2026-09-17"], ["finishedAt", null],
  ])("rejects malformed %s=%j", (field, value) => {
    expectInvalid(ProviderSearchResultSchema, { ...result(), [field as string]: value });
  });

  it("rejects malformed offers even when wrapped in an apparently successful result", () => {
    expectInvalid(ProviderSearchResultSchema, { ...result(), offers: [{ ...offer(),
      totalPrice: { amountMinor: "500.00", currency: "USD", exponent: 2 } }] }, ["offers", 0, "totalPrice", "amountMinor"]);
    expectInvalid(ProviderSearchResultSchema, { ...result(), offers: [{ ...offer(),
      expiresAt: observation().retrievedAt }] }, ["offers", 0, "expiresAt"]);
    expectInvalid(ProviderSearchResultSchema, { ...result(), offers: [{ ...offer(),
      journeys: [{ segments: [onwardSegment(), segment()] }] }] }, ["offers", 0, "journeys", 0, "segments", 1, "departureAt"]);
  });

  it("rejects unmodeled provider-result fields", () => {
    expectInvalid(ProviderSearchResultSchema, { ...result(), rawResponse: {} });
  });
});

describe.each([
  { name: "SearchRequest", schema: SearchRequestSchema },
  { name: "Segment", schema: SegmentSchema },
  { name: "Journey", schema: JourneySchema },
  { name: "Itinerary", schema: ItinerarySchema },
  { name: "ProviderObservation", schema: ProviderObservationSchema },
  { name: "FlightOffer", schema: FlightOfferSchema },
  { name: "ProviderSearchResult", schema: ProviderSearchResultSchema },
])("$name malformed root input", ({ schema }) => {
  it.each([null, undefined, [], {}, "provider payload", 0, true].map((value) => ({ value })))("fails safely for $value", ({ value }) => {
    expectInvalid(schema, value);
  });
});
