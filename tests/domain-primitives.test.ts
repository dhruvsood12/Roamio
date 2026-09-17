import { describe, expect, it } from "vitest";
import {
  AdultCountSchema,
  AirportCodeSchema,
  CabinSchema,
  CarrierCodeSchema,
  CurrencyCodeSchema,
  DateSchema,
  DurationMinutesSchema,
  MarketCodeSchema,
  MoneySchema,
  OfferWarningSchema,
  OfferWarningsSchema,
  TimestampSchema,
} from "@flightbrain/domain";

describe("canonical code syntax", () => {
  it.each([
    [AirportCodeSchema, "ARN"],
    [AirportCodeSchema, "SAN"],
    [CurrencyCodeSchema, "USD"],
    [CurrencyCodeSchema, "JPY"],
    [MarketCodeSchema, "SE"],
    [CarrierCodeSchema, "SK"],
    [CarrierCodeSchema, "U2"],
    [CarrierCodeSchema, "SAS"],
  ])("preserves a valid code", (schema, code) => {
    expect(schema.parse(code)).toBe(code);
  });

  describe.each([
    { name: "airport", schema: AirportCodeSchema, invalid: ["arn", "A1N", "ÅRN", "AR", "ARNS", "ARN\n"] },
    { name: "currency", schema: CurrencyCodeSchema, invalid: ["usd", "US1", "US$", "US", "USDD", "USD\n"] },
    { name: "market", schema: MarketCodeSchema, invalid: ["se", "S1", "S", "SWE", "SE\n"] },
    { name: "carrier", schema: CarrierCodeSchema, invalid: ["sk", "S-", "S", "SASS", "SK\n"] },
  ])("$name", ({ schema, invalid }) => {
    it.each([...invalid, "", "   ", " ARN", "ARN ", null, undefined, 123, [], {}].map((value) => ({ value })))(
      "rejects malformed code $value without normalization", ({ value }) => {
        expect(schema.safeParse(value).success).toBe(false);
      },
    );
  });
});

describe("calendar dates", () => {
  it.each(["2026-01-01", "2026-12-31", "2024-02-29", "2000-02-29"])(
    "accepts %s", (value) => expect(DateSchema.parse(value)).toBe(value),
  );
  it.each([
    "2026-02-29", "1900-02-29", "2100-02-29", "2026-04-31", "2026-00-01",
    "2026-13-01", "2026-01-00", "2026-01-32", "2026-1-01", "2026-01-1",
    "2026/01/01", "2026-01-01T00:00:00Z", "2026-01-01\n", " 2026-01-01",
    "", null, undefined, new Date("2026-01-01"), 20260101,
  ])("rejects %j", (value) => expect(DateSchema.safeParse(value).success).toBe(false));
});

describe("timestamps", () => {
  it.each([
    "2026-10-10T08:00:00Z", "2026-10-10T08:00:00+02:00", "2026-10-10T08:00:00-07:00",
    "2026-10-10T08:00:00+05:30", "2026-10-10T08:00:00+05:45",
    "2026-10-10T08:00:00+00:00", "2026-10-10T08:00:00.1Z",
    "2026-10-10T08:00:00.12Z", "2026-10-10T08:00:00.123Z", "2024-02-29T23:59:59Z",
  ])("preserves the explicit instant %s", (value) => expect(TimestampSchema.parse(value)).toBe(value));

  it.each([
    "2026-02-29T08:00:00Z", "2026-04-31T08:00:00Z", "2026-10-10",
    "2026-10-10T08:00:00", "2026-10-10T08:00Z", "2026-10-10 08:00:00Z",
    "2026-10-10T24:00:00Z", "2026-10-10T08:60:00Z", "2026-10-10T08:00:60Z",
    "2026-10-10T08:00:00+24:00", "2026-10-10T08:00:00+02:60",
    "2026-10-10T08:00:00+0200", "2026-10-10T08:00:00-00:00",
    "2026-10-10T08:00:00.1234Z", "2026-10-10T08:00:00Z\n", "",
    null, undefined, 1791619200000, new Date("2026-10-10T08:00:00Z"),
  ])("rejects malformed or ambiguous instant %j", (value) => {
    expect(TimestampSchema.safeParse(value).success).toBe(false);
  });
});

describe("money", () => {
  it.each([
    { amount: 0, currency: "USD" },
    { amount: 123.45, currency: "EUR" },
    { amount: 1000, currency: "JPY" },
    { amount: 1.234, currency: "KWD" },
    { amount: Number.MAX_SAFE_INTEGER, currency: "USD" },
  ])("preserves valid major-unit money %j", (value) => expect(MoneySchema.parse(value)).toEqual(value));

  it.each([-1, -0.001, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "100", "0", null, undefined, true])(
    "rejects invalid amounts %j", (amount) => {
      expect(MoneySchema.safeParse({ amount, currency: "USD" }).success).toBe(false);
    },
  );

  it.each([{}, { amount: 1 }, { currency: "USD" }, { amount: 1, currency: "usd" },
    { amount: 1, currency: "USD", nativeFare: 1 }, { amountMinor: 100, currency: "USD" }, null, [], "USD 1"].map((value) => ({ value })))(
    "rejects incomplete or provider-native money $value", ({ value }) => {
      expect(MoneySchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("duration in whole minutes", () => {
  it.each([0, 1, 60, 1440, Number.MAX_SAFE_INTEGER])("accepts %s", (value) => {
    expect(DurationMinutesSchema.parse(value)).toBe(value);
  });
  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "60", "PT1H", null, undefined, {}])(
    "rejects %j", (value) => expect(DurationMinutesSchema.safeParse(value).success).toBe(false),
  );
});

describe("adult passenger count", () => {
  it.each([1, 2, 9])("accepts %s", (value) => expect(AdultCountSchema.parse(value)).toBe(value));
  it.each([0, -1, 10, 1.5, NaN, Infinity, "1", true, null, undefined])("rejects %j", (value) => {
    expect(AdultCountSchema.safeParse(value).success).toBe(false);
  });
});

describe("cabins and warnings", () => {
  it.each(["economy", "premium_economy", "business", "first"])("accepts cabin %s", (value) => {
    expect(CabinSchema.parse(value)).toBe(value);
  });
  it.each(["Economy", "premium economy", "mixed", "unknown", "", null, undefined, 1])(
    "rejects unmapped cabin %j", (value) => expect(CabinSchema.safeParse(value).success).toBe(false),
  );

  const warnings = ["self_transfer", "airport_change", "overnight_layover", "mixed_cabin",
    "short_connection", "long_connection", "stale_price", "fare_conditions_unknown"];
  it.each(warnings)("accepts warning %s", (value) => expect(OfferWarningSchema.parse(value)).toBe(value));
  it("accepts distinct warnings and an empty list", () => {
    expect(OfferWarningsSchema.parse(warnings)).toEqual(warnings);
    expect(OfferWarningsSchema.parse([])).toEqual([]);
  });
  it.each(["self-transfer", "SELF_TRANSFER", "provider_special", "", null, undefined, {}])(
    "rejects unknown warning %j", (value) => expect(OfferWarningSchema.safeParse(value).success).toBe(false),
  );
  it.each([["self_transfer", "self_transfer"], ["provider_special"], [null]].map((warnings) => ({ warnings })))(
    "rejects malformed warning list $warnings", ({ warnings }) => {
      expect(OfferWarningsSchema.safeParse(warnings).success).toBe(false);
    },
  );
});
