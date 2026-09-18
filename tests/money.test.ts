import { describe, expect, expectTypeOf, it } from "vitest";
import {
  addMoney, compareMoney, CURRENCY_METADATA_V1, FlightOfferSchema, MinorUnitAmountSchema,
  moneyFromDecimalString, moneyFromMinorUnits, MoneySchema, ProviderSearchResultSchema,
  subtractMoney, SupportedCurrencyCodeSchema, type Money, type SupportedCurrencyCode,
} from "@flightbrain/domain";
import { connectingRoundTrip, offerWithJourneys } from "./fixtures/journeys";

const maximum = "99999999999999999999999999999999999999";
const usd = (amountMinor: string): Money => ({ amountMinor, currency: "USD", exponent: 2 });

describe("exact canonical Money", () => {
  it.each(["0", "1", "99", "12345", "9007199254740993", maximum])("preserves %s exactly", (amountMinor) => {
    const value = usd(amountMinor);
    const parsed = MoneySchema.parse(value);
    expect(parsed).toEqual(value);
    expectTypeOf(parsed).toEqualTypeOf<Money>();
    expectTypeOf(parsed.amountMinor).toEqualTypeOf<string>();
  });

  const invalidAmounts: unknown[] = [
    "", "00", "001", "01", "-1", "-0", "+1", "1.00", "1e2", "1E2", "0x10", "1_000", "1,000",
    " 100 ", "100 ", " 100", "100\n", "100\r", "100\r\n", "100\t", "1\u0000", "1\u2028", "１", "١",
    "100000000000000000000000000000000000000", "9".repeat(1000),
    0, 1, 0.29, -1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity,
    1n, null, undefined, true, [], {}, new String("100"),
  ];
  it.each(invalidAmounts.map((amountMinor, i) => ({ amountMinor, i })))("rejects malformed/coerced amount case $i", ({ amountMinor }) => {
    expect(MinorUnitAmountSchema.safeParse(amountMinor).success).toBe(false);
    expect(MoneySchema.safeParse({ amountMinor, currency: "USD", exponent: 2 }).success).toBe(false);
  });

  it.each(["amountMinor", "currency", "exponent"])("requires explicit %s", (key) => {
    const value: Record<string, unknown> = { ...usd("1") };
    delete value[key];
    expect(MoneySchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { amount: 0.29, currency: "USD" },
    { ...usd("29"), amount: 0.29 },
    { ...usd("29"), providerAmount: "0.29" },
    { ...usd("29"), currencyMetadataVersion: "guessed" },
  ])("rejects legacy or undeclared fields %j", (value) => {
    expect(MoneySchema.safeParse(value).success).toBe(false);
  });
});

describe("versioned currency exponents", () => {
  const supported: [SupportedCurrencyCode, number][] = [
    ["JPY", 0], ["USD", 2], ["EUR", 2], ["GBP", 2], ["INR", 2], ["SEK", 2], ["KWD", 3],
  ];
  it.each(supported)("validates %s against exponent %i", (currency, exponent) => {
    expect(MoneySchema.parse({ amountMinor: "1", currency, exponent })).toEqual({ amountMinor: "1", currency, exponent });
    expect(CURRENCY_METADATA_V1.exponents[currency]).toBe(exponent);
    for (const wrong of [0, 1, 2, 3, 4].filter((value) => value !== exponent)) {
      const parsed = MoneySchema.safeParse({ amountMinor: "1", currency, exponent: wrong });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.path)).toContainEqual(["exponent"]);
    }
  });

  it.each([-1, 1.5, "2", 2n, NaN, Infinity, null, undefined])("rejects malformed exponent %s", (exponent) => {
    expect(MoneySchema.safeParse({ ...usd("1"), exponent }).success).toBe(false);
  });

  it.each(["usd", " USD", "USD\n", "US", "ZZZ", "XXX", "XAU", "BTC", "CAD", "__proto__", null, 123])(
    "rejects unsupported or malformed currency %s without an exponent fallback", (currency) => {
      expect(SupportedCurrencyCodeSchema.safeParse(currency).success).toBe(false);
      expect(MoneySchema.safeParse({ ...usd("1"), currency }).success).toBe(false);
      expect(() => Reflect.apply(moneyFromDecimalString, undefined, ["1.00", currency])).toThrow();
      expect(() => Reflect.apply(moneyFromMinorUnits, undefined, [1n, currency])).toThrow();
    },
  );

  it("pins a frozen offline metadata version with a bounded supported subset", () => {
    expect(CURRENCY_METADATA_V1.version).toBe("iso4217-subset-v1");
    expect(CURRENCY_METADATA_V1.publishedAt).toBe("2026-09-17");
    expect(CURRENCY_METADATA_V1.sourceSha256).toBe("33139b438657d1cee116ba737807ea71d19d6de4b90f799a09c56f0cc6a1b0ff");
    expect(Object.isFrozen(CURRENCY_METADATA_V1)).toBe(true);
    expect(Object.isFrozen(CURRENCY_METADATA_V1.exponents)).toBe(true);
    expect(SupportedCurrencyCodeSchema.options.slice().sort()).toEqual(supported.map(([code]) => code).sort());
  });
});

describe("lossless decimal-text conversion", () => {
  const cases: [string, SupportedCurrencyCode, string, number][] = [
    ["0", "USD", "0", 2], ["0.00", "USD", "0", 2], ["0.01", "USD", "1", 2],
    ["0.10", "USD", "10", 2], ["0.29", "USD", "29", 2], ["1.00", "USD", "100", 2],
    ["123.45", "USD", "12345", 2], ["10", "USD", "1000", 2], ["1.2", "EUR", "120", 2],
    ["0", "JPY", "0", 0], ["123", "JPY", "123", 0], ["0", "KWD", "0", 3],
    ["0.001", "KWD", "1", 3], ["1.234", "KWD", "1234", 3], ["1.2", "KWD", "1200", 3],
    ["123.456", "KWD", "123456", 3], ["90071992547409.93", "USD", "9007199254740993", 2],
    ["999999999999999999999999999999999999.99", "USD", maximum, 2],
    [maximum, "JPY", maximum, 0], ["99999999999999999999999999999999999.999", "KWD", maximum, 3],
  ];
  it.each(cases)("converts %s %s exactly", (source, currency, amountMinor, exponent) => {
    expect(moneyFromDecimalString(source, currency)).toEqual({ amountMinor, currency, exponent });
  });

  it("avoids the 0.29 binary-float trap and rejects numeric provider input", () => {
    expect(0.29 * 100).not.toBe(29); // Regression demonstration only; never a conversion path.
    expect(moneyFromDecimalString("0.29", "USD")).toEqual(usd("29"));
    expect(() => Reflect.apply(moneyFromDecimalString, undefined, [0.29, "USD"])).toThrow();
    expect(() => moneyFromDecimalString("0.30000000000000004", "USD")).toThrow(/precision/);
  });

  it.each([
    ["1.23", "USD", "123"], ["1.230", "USD", "123"], ["1.2300", "USD", "123"],
    ["0.290", "USD", "29"], ["10.000", "USD", "1000"], ["0.000", "USD", "0"],
    ["123.0", "JPY", "123"], ["123.000", "JPY", "123"], ["0.000", "JPY", "0"],
    ["1.2340", "KWD", "1234"], ["1.23400", "KWD", "1234"], ["0.0010", "KWD", "1"],
  ] as const)("normalizes only zero excess digits in %s %s exactly", (source, currency, amountMinor) => {
    expect(moneyFromDecimalString(source, currency)).toEqual({
      amountMinor, currency, exponent: CURRENCY_METADATA_V1.exponents[currency],
    });
  });

  it.each([
    ["1.234", "USD"], ["1.2301", "USD"], ["0.001", "USD"],
    ["123.001", "JPY"], ["123.01", "JPY"], ["1.2345", "KWD"], ["1.23401", "KWD"],
  ] as const)("rejects unsupported precision %s %s without rounding", (source, currency) => {
    expect(() => moneyFromDecimalString(source, currency)).toThrow(/precision/);
  });

  it.each([
    ["999999999999999999999999999999999999.9900", "USD"],
    [`${maximum}.000`, "JPY"], ["99999999999999999999999999999999999.99900", "KWD"],
  ] as const)("preserves the 38-digit limit after exact normalization of %s %s", (source, currency) => {
    expect(moneyFromDecimalString(source, currency)).toEqual({
      amountMinor: maximum, currency, exponent: CURRENCY_METADATA_V1.exponents[currency],
    });
  });

  it("checks every excess digit even after a long run of zeros", () => {
    const source = `1.23${"0".repeat(1000)}`;
    expect(moneyFromDecimalString(source, "USD")).toEqual(usd("123"));
    expect(() => moneyFromDecimalString(`${source}1`, "USD")).toThrow(/precision/);
    expect(() => moneyFromDecimalString(`${source}\n`, "USD")).toThrow();
  });

  const malformed: unknown[] = ["", " ", "00", "01.00", "+1", "-1", "-0.00", "1e2", "1E2", ".29", "1.",
    "1,234.00", "1_000", "1.2.3", "1.00\n", "1\u2028", "1.00 ", " 1.00", "١.٢", "NaN", "Infinity",
    "9".repeat(40), 0, 0.1 + 0.2, NaN, Infinity, 1n, null, undefined, {}, []];
  it.each(malformed.map((value, i) => ({ value, i })))("rejects malformed source case $i", ({ value }) => {
    expect(() => Reflect.apply(moneyFromDecimalString, undefined, [value, "USD"])).toThrow();
  });

  it.each([
    ["1000000000000000000000000000000000000", "USD"],
    ["100000000000000000000000000000000000000", "JPY"],
    ["100000000000000000000000000000000000", "KWD"],
  ] as const)("rejects conversion overflow for %s %s", (value, currency) => {
    expect(() => moneyFromDecimalString(value, currency)).toThrow();
    expect(() => moneyFromDecimalString(`${value}.0000`, currency)).toThrow();
  });
});

describe("exact same-currency arithmetic", () => {
  it.each([
    ["10", "20", "30"], ["0", "0", "0"], ["99", "1", "100"],
    ["9007199254740992", "1", "9007199254740993"],
    ["99999999999999999999999999999999999998", "1", maximum],
  ])("adds %s + %s = %s without precision loss", (a, b, sum) => {
    expect(addMoney(usd(a), usd(b))).toEqual(usd(sum));
    expect(subtractMoney(usd(sum), usd(b))).toEqual(usd(a));
  });

  it("compares numerically rather than lexically, including adjacent huge values", () => {
    for (const [a, b] of [["2", "10"], ["9007199254740992", "9007199254740993"], ["99999999999999999999999999999999999998", maximum]]) {
      expect(compareMoney(usd(a), usd(b))).toBe(-1);
      expect(compareMoney(usd(b), usd(a))).toBe(1);
      expect(compareMoney(usd(b), usd(b))).toBe(0);
    }
    expect(subtractMoney(usd(maximum), usd(maximum))).toEqual(usd("0"));
  });

  it.each(["JPY", "KWD"] as const)("supports %s arithmetic without assuming cents", (currency) => {
    const a = moneyFromMinorUnits(10n, currency);
    const b = moneyFromMinorUnits(20n, currency);
    expect(addMoney(a, b)).toEqual(moneyFromMinorUnits(30n, currency));
    expect(compareMoney(a, b)).toBe(-1);
  });

  it("rejects sum overflow and negative results instead of wrapping or clamping", () => {
    expect(addMoney(usd(maximum), usd("0"))).toEqual(usd(maximum));
    expect(() => addMoney(usd(maximum), usd("1"))).toThrow();
    expect(() => subtractMoney(usd("0"), usd("1"))).toThrow();
    expect(() => moneyFromMinorUnits(-1n, "USD")).toThrow();
    expect(() => moneyFromMinorUnits(10n ** 38n, "USD")).toThrow();
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined])("does not coerce %s into an integer operand", (value) => {
    expect(() => Reflect.apply(moneyFromMinorUnits, undefined, [value, "USD"])).toThrow(TypeError);
  });

  it.each([compareMoney, addMoney, subtractMoney])("rejects incompatible and malformed operands", (operation) => {
    const incompatible = [
      { amountMinor: "1", currency: "EUR", exponent: 2 },
      { amountMinor: "1", currency: "JPY", exponent: 0 },
      { ...usd("1"), exponent: 3 },
      { ...usd("1"), amountMinor: 1 },
      { ...usd("1"), amountMinor: "bad" },
    ];
    for (const value of incompatible) {
      expect(() => Reflect.apply(operation, undefined, [usd("1"), value])).toThrow();
      expect(() => Reflect.apply(operation, undefined, [value, usd("1")])).toThrow();
    }
  });

  it("does not mutate frozen operands or share the returned Money object", () => {
    const a = Object.freeze(usd("10"));
    const b = Object.freeze(usd("20"));
    const before = structuredClone([a, b]);
    const sum = addMoney(a, b);
    expect(compareMoney(a, b)).toBe(-1);
    expect(subtractMoney(b, a)).toEqual(a);
    sum.amountMinor = "999";
    expect([a, b]).toEqual(before);
  });
});

describe("exact tax invariants and malformed provider data", () => {
  it.each([
    ["29", "30", true], ["30", "30", true], ["31", "30", false], ["2", "10", true], ["0", "0", true],
    ["9007199254740993", "9007199254740992", false], [maximum, maximum, true],
  ])("validates taxes %s against total %s: %s", (tax, total, valid) => {
    const offer = { ...offerWithJourneys(connectingRoundTrip()), totalPrice: usd(total), taxes: usd(tax) };
    const parsed = FlightOfferSchema.safeParse(offer);
    expect(parsed.success).toBe(valid);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.path)).toContainEqual(["taxes", "amountMinor"]);
  });

  it("accepts exact 0.10 + 0.20 taxes equal to a 0.30 total", () => {
    const taxes = addMoney(moneyFromDecimalString("0.10", "USD"), moneyFromDecimalString("0.20", "USD"));
    const offer = { ...offerWithJourneys(connectingRoundTrip()), totalPrice: moneyFromDecimalString("0.30", "USD"), taxes };
    expect(FlightOfferSchema.parse(offer).taxes).toEqual(usd("30"));
  });

  it.each([
    { ...usd("1"), currency: "EUR" }, { ...usd("1"), exponent: 0 },
    { ...usd("1"), amountMinor: "bad" }, { ...usd("1"), amountMinor: 1 },
    { ...usd("1"), amountMinor: "9".repeat(39) },
  ])("rejects invalid nested Money without throwing from safeParse: %j", (money) => {
    for (const field of ["taxes", "totalPrice"]) {
      const offer = { ...offerWithJourneys(connectingRoundTrip()), taxes: usd("1"), [field]: money };
      const parse = () => FlightOfferSchema.safeParse(offer);
      expect(parse).not.toThrow();
      expect(parse().success).toBe(false);
      const result = ProviderSearchResultSchema.safeParse({
        provider: "fixture", offers: [offer], status: "success",
        startedAt: "2026-09-17T10:00:00Z", finishedAt: "2026-09-17T10:00:01Z",
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("JSON boundaries", () => {
  it.each([
    usd("0"), usd("1"), usd("9007199254740993"), usd(maximum),
    { amountMinor: maximum, currency: "JPY", exponent: 0 },
    { amountMinor: maximum, currency: "KWD", exponent: 3 },
  ])("round-trips exact money %j without bigint or number coercion", (money) => {
    const parsed = MoneySchema.parse(money);
    const json = JSON.stringify(parsed);
    expect(MoneySchema.parse(JSON.parse(json))).toEqual(parsed);
    expect(JSON.parse(json).amountMinor).toBe(money.amountMinor);
  });

  it("round-trips maximum-size total and taxes inside a canonical offer", () => {
    const offer = FlightOfferSchema.parse({ ...offerWithJourneys(connectingRoundTrip()), totalPrice: usd(maximum), taxes: usd(maximum) });
    expect(FlightOfferSchema.parse(JSON.parse(JSON.stringify(offer)))).toEqual(offer);
  });
});
