import { z } from "zod";
import { addMoney, MoneySchema, type Money } from "./money";

// Application/domain-assigned IDs, not a registry or provider-name normalization.
export const LoyaltyProgramRefSchema = z.strictObject({
  id: z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/),
});
export type LoyaltyProgramRef = z.infer<typeof LoyaltyProgramRefSchema>;

// Same 38-digit capacity as cash, but a separate unit with no monetary meaning.
export const PointsAmountSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,37})(?![\s\S])/);
export type PointsAmount = z.infer<typeof PointsAmountSchema>;
export function addPoints(a: PointsAmount, b: PointsAmount): PointsAmount {
  return PointsAmountSchema.parse((BigInt(PointsAmountSchema.parse(a)) + BigInt(PointsAmountSchema.parse(b))).toString());
}
export function comparePoints(a: PointsAmount, b: PointsAmount): -1 | 0 | 1 {
  const left = BigInt(PointsAmountSchema.parse(a));
  const right = BigInt(PointsAmountSchema.parse(b));
  return left < right ? -1 : left > right ? 1 : 0;
}

export const CashPaymentQuoteSchema = z.strictObject({ kind: z.literal("cash"), amount: MoneySchema });
export const AwardPaymentQuoteSchema = z.strictObject({
  kind: z.literal("award"), program: LoyaltyProgramRefSchema, points: PointsAmountSchema,
  // Required, complete cash obligations. [] means explicitly none, never unknown.
  taxesAndFees: z.array(MoneySchema),
});
export const CashAndPointsPaymentQuoteSchema = z.strictObject({
  kind: z.literal("cash_and_points"), program: LoyaltyProgramRefSchema, points: PointsAmountSchema,
  cash: z.array(MoneySchema).min(1),
});
export const PaymentQuoteSchema = z.discriminatedUnion("kind", [
  CashPaymentQuoteSchema, AwardPaymentQuoteSchema, CashAndPointsPaymentQuoteSchema,
]);
export type CashPaymentQuote = z.infer<typeof CashPaymentQuoteSchema>;
export type AwardPaymentQuote = z.infer<typeof AwardPaymentQuoteSchema>;
export type CashAndPointsPaymentQuote = z.infer<typeof CashAndPointsPaymentQuoteSchema>;
export type PaymentQuote = z.infer<typeof PaymentQuoteSchema>;

export const TripPaymentSummarySchema = z.strictObject({
  cashByCurrency: z.array(MoneySchema),
  pointsByProgram: z.array(z.strictObject({ program: LoyaltyProgramRefSchema, points: PointsAmountSchema })),
}).superRefine((summary, ctx) => {
  for (const field of ["cashByCurrency", "pointsByProgram"] as const) {
    const keys = field === "cashByCurrency" ? summary.cashByCurrency.map((m) => m.currency)
      : summary.pointsByProgram.map((p) => p.program.id);
    if (keys.some((key, i) => i > 0 && key <= keys[i - 1])) {
      ctx.addIssue({ code: "custom", path: [field], message: "Summary keys must be unique and in ascending ASCII order" });
    }
  }
});
export type TripPaymentSummary = z.infer<typeof TripPaymentSummarySchema>;

// Validates even typed callers, adds only like units, and never mutates inputs.
export function summarizePayments(rawQuotes: readonly PaymentQuote[]): TripPaymentSummary {
  const quotes = z.array(PaymentQuoteSchema).parse(rawQuotes);
  const cash = new Map<string, Money>();
  const points = new Map<string, PointsAmount>();
  for (const quote of quotes) {
    const amounts = quote.kind === "cash" ? [quote.amount] : quote.kind === "award" ? quote.taxesAndFees : quote.cash;
    for (const amount of amounts) {
      const previous = cash.get(amount.currency);
      cash.set(amount.currency, previous ? addMoney(previous, amount) : amount);
    }
    if (quote.kind !== "cash") {
      points.set(quote.program.id, addPoints(points.get(quote.program.id) ?? "0", quote.points));
    }
  }
  return TripPaymentSummarySchema.parse({
    cashByCurrency: [...cash.keys()].sort().map((key) => cash.get(key)!),
    pointsByProgram: [...points.keys()].sort().map((id) => ({ program: { id }, points: points.get(id)! })),
  });
}
