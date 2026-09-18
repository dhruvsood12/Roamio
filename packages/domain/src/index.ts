import { z } from "zod";
import { compareMoney, MoneySchema } from "./money";

export {
  addMoney, compareMoney, CURRENCY_METADATA_V1, MinorUnitAmountSchema,
  moneyFromDecimalString, moneyFromMinorUnits, MoneySchema, subtractMoney,
  SupportedCurrencyCodeSchema, type Money, type SupportedCurrencyCode,
} from "./money";

// Canonical codes are already normalized; adapters must not rely on coercion here.
// These check code syntax, not membership in an airport/currency/country registry.
export const AirportCodeSchema = z.string().regex(/^[A-Z]{3}$/);
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);
export const MarketCodeSchema = z.string().regex(/^[A-Z]{2}$/);
export const CarrierCodeSchema = z.string().regex(/^[A-Z0-9]{2,3}$/);
export type CarrierCode = z.infer<typeof CarrierCodeSchema>;

const NonBlankStringSchema = z.string().min(1).refine(
  (value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value),
  "Must be nonblank, without surrounding whitespace or control characters",
);

// Preserve opaque number spelling; source-specific normalization belongs in adapters.
export const FlightNumberSchema = NonBlankStringSchema;
export type FlightNumber = z.infer<typeof FlightNumberSchema>;

export const DateSchema = z.iso.date();
// Millisecond precision matches the Date.parse comparisons below.
// RFC 3339's -00:00 denotes an unknown offset, not an authoritative instant.
export const TimestampSchema = z.iso.datetime({ offset: true })
  .regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => !value.endsWith("-00:00") && Number.isFinite(Date.parse(value)),
    "Must identify a known, parseable instant");

export const DurationMinutesSchema = z.number().int().nonnegative();
export type DurationMinutes = z.infer<typeof DurationMinutesSchema>;

export const AdultCountSchema = z.number().int().min(1).max(9);
export const CabinSchema = z.enum(["economy", "premium_economy", "business", "first"]);
export type Cabin = z.infer<typeof CabinSchema>;

export const SegmentSchema = z.strictObject({
  origin: AirportCodeSchema,
  destination: AirportCodeSchema,
  departureAt: TimestampSchema,
  arrivalAt: TimestampSchema,
  marketingCarrier: CarrierCodeSchema,
  marketingFlightNumber: FlightNumberSchema,
  // Explicit source facts only. Never fall back to the marketing identity.
  operatingCarrier: CarrierCodeSchema.nullable(),
  operatingFlightNumber: FlightNumberSchema.nullable(),
  cabin: CabinSchema,
  aircraft: NonBlankStringSchema.nullable().optional(),
}).superRefine((segment, ctx) => {
  if (segment.origin === segment.destination) {
    ctx.addIssue({ code: "custom", path: ["destination"], message: "Segment airports must differ" });
  }
  if (Date.parse(segment.arrivalAt) <= Date.parse(segment.departureAt)) {
    ctx.addIssue({ code: "custom", path: ["arrivalAt"], message: "Arrival must follow departure" });
  }
});
export type Segment = z.infer<typeof SegmentSchema>;

function validateSegmentOrder(journey: { segments: Segment[] }, ctx: z.RefinementCtx) {
  journey.segments.forEach((segment, index) => {
    const previous = journey.segments[index - 1];
    if (previous && Date.parse(segment.departureAt) < Date.parse(previous.arrivalAt)) {
      ctx.addIssue({
        code: "custom", path: ["segments", index, "departureAt"],
        message: "Segments must be ordered without overlapping travel times",
      });
    }
  });
}

export const JourneySchema = z.strictObject({
  segments: z.tuple([SegmentSchema]).rest(SegmentSchema),
}).superRefine(validateSegmentOrder);
export type Journey = z.infer<typeof JourneySchema>;

// Boundaries are supplied explicitly, never inferred from elapsed-time gaps.
// Segment chronology is checked within each journey, not between journeys.
const itineraryShape = { journeys: z.tuple([JourneySchema]).rest(JourneySchema) };
export const ItinerarySchema = z.strictObject(itineraryShape);
export type Itinerary = z.infer<typeof ItinerarySchema>;

export const OfferWarningSchema = z.enum([
  "self_transfer",
  "airport_change",
  "overnight_layover",
  "mixed_cabin",
  "short_connection",
  "long_connection",
  "stale_price",
  "fare_conditions_unknown",
]);
export type OfferWarning = z.infer<typeof OfferWarningSchema>;
export const OfferWarningsSchema = z.array(OfferWarningSchema).refine(
  (warnings) => new Set(warnings).size === warnings.length,
  "Warnings must not contain duplicates",
);

const BookingUrlSchema = z.string().refine((value) => {
  if (!/^https?:\/\/[^/?#\\\s]+/i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Booking URL must be an absolute HTTP(S) URL without credentials or whitespace");

const observationShape = {
  provider: NonBlankStringSchema,
  providerOfferId: NonBlankStringSchema,
  bookingUrl: BookingUrlSchema.nullable(),
  retrievedAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  requiresRevalidation: z.boolean(),
  providerMetadata: z.record(z.string(), z.unknown()).default({}),
};

function validateObservation(
  observation: { retrievedAt: string; expiresAt: string | null }, ctx: z.RefinementCtx,
) {
  if (observation.expiresAt !== null &&
    Date.parse(observation.expiresAt) <= Date.parse(observation.retrievedAt)) {
    ctx.addIssue({
      code: "custom", path: ["expiresAt"], message: "Expiry must follow retrieval when known",
    });
  }
}

export const ProviderObservationSchema = z.strictObject(observationShape)
  .superRefine(validateObservation);
export type ProviderObservation = z.infer<typeof ProviderObservationSchema>;

export const FlightOfferSchema = z.strictObject({
  id: NonBlankStringSchema,
  ...itineraryShape,
  ...observationShape,
  totalPrice: MoneySchema,
  taxes: MoneySchema.nullable().optional(),
  fareBrand: NonBlankStringSchema.nullable().optional(),
  refundable: z.boolean().nullable(),
  changeable: z.boolean().nullable(),
  checkedBags: z.number().int().nonnegative().nullable(),
  cabinBags: z.number().int().nonnegative().nullable(),
  warnings: OfferWarningsSchema.default([]),
}).superRefine(validateObservation).superRefine((offer, ctx) => {
  if (offer.taxes) {
    // Nested refinements may have failed without aborting this refinement. Never
    // pass malformed amounts to BigInt or let safeParse throw on provider data.
    const taxes = MoneySchema.safeParse(offer.taxes);
    const total = MoneySchema.safeParse(offer.totalPrice);
    if (taxes.success && total.success && taxes.data.currency !== total.data.currency) {
      ctx.addIssue({ code: "custom", path: ["taxes", "currency"], message: "Taxes must use the total price currency" });
    } else if (taxes.success && total.success && compareMoney(taxes.data, total.data) > 0) {
      ctx.addIssue({ code: "custom", path: ["taxes", "amountMinor"], message: "Taxes cannot exceed the tax-inclusive total" });
    }
  }
  const requiredWarnings: OfferWarning[] = [];
  if (new Set(offer.journeys.flatMap((journey) => journey.segments.map((segment) => segment.cabin))).size > 1) {
    requiredWarnings.push("mixed_cabin");
  }
  if (offer.journeys.some((journey) => journey.segments.some((segment, index) =>
    index > 0 && segment.origin !== journey.segments[index - 1].destination))) {
    requiredWarnings.push("airport_change");
  }
  for (const warning of requiredWarnings) {
    if (!offer.warnings.includes(warning)) {
      ctx.addIssue({ code: "custom", path: ["warnings"], message: `Missing required ${warning} warning` });
    }
  }
});
export type FlightOffer = z.infer<typeof FlightOfferSchema>;

const AirportListSchema = z.array(AirportCodeSchema).min(1).refine(
  (airports) => new Set(airports).size === airports.length,
  "Airport lists must not contain duplicates",
);

export const SearchRequestSchema = z.strictObject({
  origins: AirportListSchema,
  destinations: AirportListSchema,
  departureDate: DateSchema,
  returnDate: DateSchema.nullable().optional(),
  adults: AdultCountSchema.default(1),
  cabins: z.array(CabinSchema).min(1).refine(
    (cabins) => new Set(cabins).size === cabins.length, "Cabins must not contain duplicates",
  ),
  maxStops: z.number().int().min(0).max(3).default(1),
  currency: CurrencyCodeSchema.default("USD"),
  market: MarketCodeSchema.optional(),
}).superRefine((request, ctx) => {
  if (request.returnDate && request.returnDate < request.departureDate) {
    ctx.addIssue({ code: "custom", path: ["returnDate"], message: "Return date cannot precede departure date" });
  }
  if (request.origins.some((origin) => request.destinations.includes(origin))) {
    ctx.addIssue({ code: "custom", path: ["destinations"], message: "Origin and destination sets must be disjoint" });
  }
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const ProviderSearchResultSchema = z.strictObject({
  provider: NonBlankStringSchema,
  offers: z.array(FlightOfferSchema),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  status: z.enum(["success", "timeout", "error"]),
  errorCode: NonBlankStringSchema.optional(),
}).superRefine((result, ctx) => {
  if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
    ctx.addIssue({ code: "custom", path: ["finishedAt"], message: "Completion cannot precede start" });
  }
  if (result.status !== "success" && result.offers.length > 0) {
    ctx.addIssue({ code: "custom", path: ["offers"], message: "Failed searches cannot claim successful offers" });
  }
  if (result.status === "success" && result.errorCode !== undefined) {
    ctx.addIssue({ code: "custom", path: ["errorCode"], message: "Successful searches cannot include an error code" });
  }
  result.offers.forEach((offer, index) => {
    if (offer.provider !== result.provider) {
      ctx.addIssue({ code: "custom", path: ["offers", index, "provider"], message: "Offer provenance must match the result provider" });
    }
  });
});
export type ProviderSearchResult = z.infer<typeof ProviderSearchResultSchema>;
