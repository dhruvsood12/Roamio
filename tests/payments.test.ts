import { describe, expect, it } from "vitest";
import {
  addPoints, comparePoints, LoyaltyProgramRefSchema, PaymentQuoteSchema, PointsAmountSchema,
  summarizePayments, TripPaymentSummarySchema, type Money, type PaymentQuote,
} from "@flightbrain/domain";

const max = "9".repeat(38);
const usd = (amountMinor: string): Money => ({ amountMinor, currency: "USD", exponent: 2 });
const cash = (amountMinor: string): PaymentQuote => ({ kind: "cash", amount: usd(amountMinor) });
const award = (points: string, id = "aeroplan", fees: Money[] = []): PaymentQuote => ({ kind: "award", program: { id }, points, taxesAndFees: fees });

describe("points and program identities", () => {
  it.each(["0", "1", "9007199254740993", max])("preserves exact points %s", (v) => expect(PointsAmountSchema.parse(v)).toBe(v));
  it.each(["", "00", "01", "-1", "+1", "1.0", "1e2", " 1", "1 ", "1\n", "١", "9".repeat(39), 1, 1n, null, NaN, Infinity])(
    "rejects malformed points %s", (v) => expect(PointsAmountSchema.safeParse(v).success).toBe(false),
  );
  it.each(["aeroplan", "united-mileageplus", "british-airways-club", "flying-blue", "a".repeat(64)])(
    "accepts domain-assigned program %s", (id) => expect(LoyaltyProgramRefSchema.parse({ id })).toEqual({ id }),
  );
  it.each(["Aeroplan", " aeroplan", "aeroplan\n", "united_mileageplus", "-a", "a-", "a--b", "", "a".repeat(65), null, 1])(
    "rejects noncanonical program %s", (id) => expect(LoyaltyProgramRefSchema.safeParse({ id }).success).toBe(false),
  );
  it("keeps points arithmetic exact, bounded and free of coercion", () => {
    expect(addPoints("55000", "20000")).toBe("75000");
    expect(addPoints("9007199254740992", "1")).toBe("9007199254740993");
    expect(addPoints(max, "0")).toBe(max);
    expect(comparePoints("2", "10")).toBe(-1);
    expect(comparePoints(max, "9007199254740993")).toBe(1);
    expect(comparePoints(max, max)).toBe(0);
    expect(() => addPoints(max, "1")).toThrow();
    for (const op of [addPoints, comparePoints]) expect(() => Reflect.apply(op, undefined, [1, "1"])).toThrow();
  });
});

describe("strict payment contracts", () => {
  it.each([
    cash("0"), award("0"), award(max, "aeroplan", [usd("560")]),
    { kind: "cash_and_points", program: { id: "flying-blue" }, points: "7500", cash: [usd("1000")] },
  ])("round-trips %j", (quote) => expect(PaymentQuoteSchema.parse(JSON.parse(JSON.stringify(quote)))).toEqual(quote));
  it.each([
    {}, { kind: "crypto" }, { kind: "cash", amount: { amount: 100, currency: "USD" } },
    { ...cash("100"), pointsValue: 100 }, { ...award("1"), effectiveCost: usd("500") },
    { kind: "award", points: "1", taxesAndFees: [] }, { kind: "award", program: { id: "aeroplan" }, points: "1" },
    { ...award("1"), taxesAndFees: null }, { ...award("1"), program: { id: "aeroplan", valuation: 0.01 } },
    { kind: "cash_and_points", program: { id: "aeroplan" }, points: "1", cash: [] },
    { ...cash("1"), amount: { amountMinor: "1", currency: "JPY", exponent: 2 } },
  ])("rejects malformed or valuation-bearing quotes %j", (quote) => expect(PaymentQuoteSchema.safeParse(quote).success).toBe(false));
});

describe("native-unit payment summaries", () => {
  it("adds cash exactly and sorts currencies independently of encounter order", () => {
    const quotes: PaymentQuote[] = [cash("10000"), { kind: "cash", amount: { amountMinor: "10000", currency: "JPY", exponent: 0 } }, cash("5000"),
      { kind: "cash", amount: { amountMinor: "500000", currency: "INR", exponent: 2 } }];
    const expected = { cashByCurrency: [
      { amountMinor: "500000", currency: "INR", exponent: 2 }, { amountMinor: "10000", currency: "JPY", exponent: 0 }, usd("15000")], pointsByProgram: [] };
    expect(summarizePayments(quotes)).toEqual(expected);
    expect(summarizePayments(quotes.slice().reverse())).toEqual(expected);
    expect(summarizePayments([cash("10"), cash("20")]).cashByCurrency).toEqual([usd("30")]);
  });
  it("adds only within the same program, including exact large amounts", () => {
    const quotes = [award("55000"), award("20000", "united-mileageplus"), award("20000")];
    expect(summarizePayments(quotes)).toEqual({ cashByCurrency: [], pointsByProgram: [
      { program: { id: "aeroplan" }, points: "75000" }, { program: { id: "united-mileageplus" }, points: "20000" }] });
    expect(summarizePayments(quotes.slice().reverse())).toEqual(summarizePayments(quotes));
    expect(summarizePayments([award("9007199254740992"), award("1")]).pointsByProgram[0].points).toBe("9007199254740993");
  });
  it("retains hybrid obligations without manufacturing a universal cost", () => {
    expect(summarizePayments([award("55000"), cash("41000"), award("7500", "united-mileageplus", [usd("560")])])).toEqual({
      cashByCurrency: [usd("41560")], pointsByProgram: [
        { program: { id: "aeroplan" }, points: "55000" }, { program: { id: "united-mileageplus" }, points: "7500" }],
    });
  });
  it("supports genuine single-booking cash-and-points, including fee line items", () => {
    expect(summarizePayments([{ kind: "cash_and_points", program: { id: "aeroplan" }, points: "100", cash: [usd("10"), usd("20")] }, award("25")])).toEqual({
      cashByCurrency: [usd("30")], pointsByProgram: [{ program: { id: "aeroplan" }, points: "125" }],
    });
  });
  it("preserves explicit zero obligations, and does not invent absent fees", () => {
    expect(summarizePayments([])).toEqual({ cashByCurrency: [], pointsByProgram: [] });
    expect(summarizePayments([cash("0"), award("0")])).toEqual({ cashByCurrency: [usd("0")], pointsByProgram: [{ program: { id: "aeroplan" }, points: "0" }] });
  });
  it("rejects overflow and currency/exponent mismatches instead of rounding", () => {
    expect(() => summarizePayments([cash(max), cash("1")])).toThrow();
    expect(() => summarizePayments([award(max), award("1")])).toThrow();
    expect(() => summarizePayments([{ kind: "cash", amount: { ...usd("1"), exponent: 0 } }])).toThrow();
  });
  it("leaves deeply frozen inputs unchanged and returns independent objects", () => {
    const quote = award("1", "aeroplan", [Object.freeze(usd("10"))]);
    if (quote.kind !== "award") throw Error("fixture");
    Object.freeze(quote.program); Object.freeze(quote.taxesAndFees); Object.freeze(quote);
    const quotes = Object.freeze([quote]);
    const before = JSON.stringify(quotes);
    const result = summarizePayments(quotes);
    result.cashByCurrency[0].amountMinor = "999";
    expect(JSON.stringify(quotes)).toBe(before);
    expect(TripPaymentSummarySchema.parse(JSON.parse(JSON.stringify(summarizePayments(quotes))))).toEqual(summarizePayments(quotes));
  });
  it.each([
    { cashByCurrency: [usd("1"), usd("2")], pointsByProgram: [] },
    { cashByCurrency: [usd("1"), { amountMinor: "1", currency: "JPY", exponent: 0 }], pointsByProgram: [] },
    { cashByCurrency: [], pointsByProgram: [{ program: { id: "b" }, points: "1" }, { program: { id: "a" }, points: "1" }] },
    { cashByCurrency: [], pointsByProgram: [{ program: { id: "a" }, points: "1" }, { program: { id: "a" }, points: "2" }] },
    { cashByCurrency: [], pointsByProgram: [], dollarEquivalent: 0 },
  ])("rejects ambiguous, unsorted or invented summaries %j", (value) => expect(TripPaymentSummarySchema.safeParse(value).success).toBe(false));
});
