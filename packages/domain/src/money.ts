import { z } from "zod";

export const SupportedCurrencyCodeSchema = z.enum(["EUR", "GBP", "INR", "JPY", "KWD", "SEK", "USD"]);
export type SupportedCurrencyCode = z.infer<typeof SupportedCurrencyCodeSchema>;

// Deliberate supported subset, verified against SIX List One. No runtime lookup.
// Preserve this snapshot; changes require a new metadata version and explicit migration.
export const CURRENCY_METADATA_V1 = Object.freeze({
  version: "iso4217-subset-v1",
  publishedAt: "2026-09-17",
  source: "https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml",
  sourceSha256: "33139b438657d1cee116ba737807ea71d19d6de4b90f799a09c56f0cc6a1b0ff",
  exponents: Object.freeze({ EUR: 2, GBP: 2, INR: 2, JPY: 0, KWD: 3, SEK: 2, USD: 2 } satisfies Record<SupportedCurrencyCode, number>),
});

// The final assertion requires the actual end of input, including after newlines.
export const MinorUnitAmountSchema = z.string().regex(
  /^(?:0|[1-9][0-9]{0,37})(?![\s\S])/,
  "Must be a canonical nonnegative integer string with at most 38 digits",
);

export const MoneySchema = z.strictObject({
  amountMinor: MinorUnitAmountSchema,
  currency: SupportedCurrencyCodeSchema,
  exponent: z.number().int().nonnegative(),
}).superRefine((money, ctx) => {
  if (money.exponent !== CURRENCY_METADATA_V1.exponents[money.currency]) {
    ctx.addIssue({ code: "custom", path: ["exponent"], message: "Exponent must match currency metadata V1" });
  }
});
export type Money = z.infer<typeof MoneySchema>;

export function moneyFromMinorUnits(amountMinor: bigint, currency: SupportedCurrencyCode): Money {
  if (typeof amountMinor !== "bigint") throw new TypeError("Minor-unit arithmetic requires bigint, never number");
  const code = SupportedCurrencyCodeSchema.parse(currency);
  return MoneySchema.parse({ amountMinor: amountMinor.toString(), currency: code, exponent: CURRENCY_METADATA_V1.exponents[code] });
}

// Bound the integer part before BigInt parsing; extra fractional zeros do not
// consume canonical precision or count toward the 38-digit minor-unit limit.
const DecimalAmountSchema = z.string().regex(
  /^(?:0|[1-9][0-9]{0,37})(?:\.[0-9]+)?(?![\s\S])/,
  "Expected unsigned decimal text without whitespace, leading zeros or exponent notation",
);

// Use source decimal text (or a losslessly retained numeric token), never String(number).
// Only zero excess fractional digits may be removed; no rounding is performed.
export function moneyFromDecimalString(amount: string, currency: SupportedCurrencyCode): Money {
  const code = SupportedCurrencyCodeSchema.parse(currency);
  const exponent = CURRENCY_METADATA_V1.exponents[code];
  const [whole, fraction = ""] = DecimalAmountSchema.parse(amount).split(".");
  if (/[1-9]/.test(fraction.slice(exponent))) throw new RangeError("Source precision exceeds the currency exponent");
  const canonicalFraction = fraction.slice(0, exponent).padEnd(exponent, "0");
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(canonicalFraction || "0");
  return moneyFromMinorUnits(minor, code);
}

function comparableAmounts(a: Money, b: Money): [bigint, bigint] {
  const left = MoneySchema.parse(a);
  const right = MoneySchema.parse(b);
  if (left.currency !== right.currency) {
    throw new RangeError("Different currencies cannot be compared or combined without explicit FX conversion");
  }
  return [BigInt(left.amountMinor), BigInt(right.amountMinor)];
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  const [left, right] = comparableAmounts(a, b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function addMoney(a: Money, b: Money): Money {
  const [left, right] = comparableAmounts(a, b);
  return moneyFromMinorUnits(left + right, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  const [left, right] = comparableAmounts(a, b);
  return moneyFromMinorUnits(left - right, a.currency);
}
