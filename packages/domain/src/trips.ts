import { z } from "zod";
import { AirportCodeSchema, FlightOfferSchema, TimestampSchema, type FlightOffer, type Segment } from "./flights";
import { compareMoney } from "./money";
import { PaymentQuoteSchema, summarizePayments, TripPaymentSummarySchema } from "./payments";

const IdSchema = z.string().min(1).refine((s) => s.trim() === s && !/[\u0000-\u001f\u007f]/.test(s));
const IndexSchema = z.number().int().nonnegative();
const MillisecondsSchema = z.number().int().nonnegative();
const FingerprintSchema = z.string().regex(/^fb:schedule:v1:[a-f0-9]{64}(?![\s\S])/);

// Explicit public allowlist. New observation fields never become public implicitly.
// Keep schedule, provenance and commercial facts needed to validate and assess the
// selected booking; providerMetadata belongs only to the internal observation.
export const TripSourceSnapshotSchema = z.strictObject({
  id: FlightOfferSchema.shape.id,
  journeys: FlightOfferSchema.shape.journeys,
  provider: FlightOfferSchema.shape.provider,
  providerOfferId: FlightOfferSchema.shape.providerOfferId,
  bookingUrl: FlightOfferSchema.shape.bookingUrl,
  retrievedAt: FlightOfferSchema.shape.retrievedAt,
  expiresAt: FlightOfferSchema.shape.expiresAt,
  requiresRevalidation: FlightOfferSchema.shape.requiresRevalidation,
  totalPrice: FlightOfferSchema.shape.totalPrice,
  taxes: FlightOfferSchema.shape.taxes,
  fareBrand: FlightOfferSchema.shape.fareBrand,
  refundable: FlightOfferSchema.shape.refundable,
  changeable: FlightOfferSchema.shape.changeable,
  checkedBags: FlightOfferSchema.shape.checkedBags,
  cabinBags: FlightOfferSchema.shape.cabinBags,
  warnings: FlightOfferSchema.shape.warnings,
}).superRefine((snapshot, ctx) => {
  // Reuse every offer refinement, including taxes, expiry and required warnings.
  // The validator's default internal metadata stays out of the projection result.
  const validated = FlightOfferSchema.safeParse(snapshot);
  if (!validated.success) for (const issue of validated.error.issues) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});
export type TripSourceSnapshot = z.infer<typeof TripSourceSnapshotSchema>;

function tripSourceSnapshot(source: FlightOffer): TripSourceSnapshot {
  return TripSourceSnapshotSchema.parse({
    id: source.id,
    journeys: source.journeys,
    provider: source.provider,
    providerOfferId: source.providerOfferId,
    bookingUrl: source.bookingUrl,
    retrievedAt: source.retrievedAt,
    expiresAt: source.expiresAt,
    requiresRevalidation: source.requiresRevalidation,
    totalPrice: source.totalPrice,
    ...(source.taxes === undefined ? {} : { taxes: source.taxes }),
    ...(source.fareBrand === undefined ? {} : { fareBrand: source.fareBrand }),
    refundable: source.refundable,
    changeable: source.changeable,
    checkedBags: source.checkedBags,
    cabinBags: source.cabinBags,
    warnings: source.warnings,
  });
}

export const BookingComponentSchema = z.strictObject({
  id: IdSchema,
  provider: IdSchema,
  providerOfferId: IdSchema,
  offerId: IdSchema,
  // Local snapshot index disambiguates repeated/non-global provider offer IDs.
  sourceOfferIndex: IndexSchema,
  scheduleFingerprint: FingerprintSchema.nullable(),
  order: IndexSchema,
  payment: PaymentQuoteSchema,
});
export type BookingComponent = z.infer<typeof BookingComponentSchema>;

export const TravelSegmentRefSchema = z.strictObject({
  componentIndex: IndexSchema, journeyIndex: IndexSchema, segmentIndex: IndexSchema,
});
export type TravelSegmentRef = z.infer<typeof TravelSegmentRefSchema>;
export const TripJourneyPlanSchema = z.strictObject({
  // Resolved actual airports for this requested journey; no metro expansion here.
  requestedOrigin: AirportCodeSchema, requestedDestination: AirportCodeSchema,
  segments: z.tuple([TravelSegmentRefSchema]).rest(TravelSegmentRefSchema),
});
export type TripJourneyPlan = z.infer<typeof TripJourneyPlanSchema>;

export const ProtectionStateSchema = z.enum(["protected", "self_transfer", "unknown"]);
export type ProtectionState = z.infer<typeof ProtectionStateSchema>;
const ProtectionEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unknown") }),
  z.strictObject({ kind: z.literal("separate_bookings") }),
  z.strictObject({ kind: z.literal("provider"), provider: IdSchema, providerOfferId: IdSchema, reference: IdSchema }),
]);
export const ConnectionSchema = z.strictObject({
  journeyIndex: IndexSchema, fromSegmentIndex: IndexSchema,
  fromComponentIndex: IndexSchema, toComponentIndex: IndexSchema,
  arrivalAirport: AirportCodeSchema, departureAirport: AirportCodeSchema,
  arrivalAt: TimestampSchema, departureAt: TimestampSchema,
  durationMilliseconds: MillisecondsSchema,
  airportChange: z.boolean(), crossesBookingBoundary: z.boolean(),
  protection: ProtectionStateSchema, evidence: ProtectionEvidenceSchema,
}).superRefine((c, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const elapsed = Date.parse(c.departureAt) - Date.parse(c.arrivalAt);
  if (elapsed < 0 || elapsed !== c.durationMilliseconds) issue("Connection duration must equal its nonnegative elapsed time");
  if (c.airportChange !== (c.arrivalAirport !== c.departureAirport)) issue("Airport-change flag must match actual airports");
  if (c.crossesBookingBoundary !== (c.fromComponentIndex !== c.toComponentIndex)) issue("Booking boundary must match component references");
  if (c.crossesBookingBoundary) {
    if (c.protection !== "self_transfer" || c.evidence.kind !== "separate_bookings") issue("Independent bookings require self-transfer disclosure");
  } else if (c.protection === "unknown") {
    if (c.evidence.kind !== "unknown") issue("Unknown protection cannot claim evidence");
  } else if (c.evidence.kind !== "provider") issue("Same-component protection needs explicit provider evidence");
});
export type Connection = z.infer<typeof ConnectionSchema>;

// Evidence is supplied only for known within-component connections. A provider
// reference is an attributed assertion, not proof independently verified here.
export const ConnectionProtectionFactSchema = z.strictObject({
  journeyIndex: IndexSchema, fromSegmentIndex: IndexSchema,
  protection: z.enum(["protected", "self_transfer"]), reference: IdSchema,
});
export type ConnectionProtectionFact = z.infer<typeof ConnectionProtectionFactSchema>;

export const TripWarningSchema = z.enum([
  "self_transfer", "multiple_booking_components", "airport_change", "mixed_payment", "unknown_connection_protection",
]);
export type TripWarning = z.infer<typeof TripWarningSchema>;

const planShape = {
  id: IdSchema,
  // Internal input retains full observations. TripOption exposes projections only.
  sourceOffers: z.tuple([FlightOfferSchema]).rest(FlightOfferSchema),
  bookingComponents: z.tuple([BookingComponentSchema]).rest(BookingComponentSchema),
  journeys: z.tuple([TripJourneyPlanSchema]).rest(TripJourneyPlanSchema),
  protectionFacts: z.array(ConnectionProtectionFactSchema),
};
const PlanBaseSchema = z.strictObject(planShape);
type Plan = z.infer<typeof PlanBaseSchema>;
function segmentFor(plan: Plan, ref: TravelSegmentRef): Segment | undefined {
  const component = plan.bookingComponents[ref.componentIndex];
  return component && plan.sourceOffers[component.sourceOfferIndex]?.journeys[ref.journeyIndex]?.segments[ref.segmentIndex];
}
function isJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every((v) => isJson(v, ancestors));
  ancestors.delete(value);
  return valid;
}

export const TripPlanSchema = PlanBaseSchema.superRefine((plan, ctx) => {
  // Do not dereference or perform arithmetic on data whose nested validation failed.
  if (!PlanBaseSchema.safeParse(plan).success) return;
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const components = plan.bookingComponents;
  if (new Set(components.map((c) => c.id)).size !== components.length) issue(["bookingComponents"], "Component IDs must be unique within this trip");
  if (plan.sourceOffers.length !== components.length || new Set(components.map((c) => c.sourceOfferIndex)).size !== components.length) {
    issue(["sourceOffers"], "Every selected source snapshot must be referenced exactly once");
  }
  plan.sourceOffers.forEach((offer, i) => {
    if (!isJson(offer.providerMetadata)) issue(["sourceOffers", i, "providerMetadata"], "Trip source metadata must be JSON-safe");
  });
  components.forEach((component, i) => {
    if (component.order !== i) issue(["bookingComponents", i, "order"], "Component order must equal its zero-based array position");
    const source = plan.sourceOffers[component.sourceOfferIndex];
    if (!source) { issue(["bookingComponents", i, "sourceOfferIndex"], "Missing source offer"); return; }
    if (component.provider !== source.provider || component.providerOfferId !== source.providerOfferId || component.offerId !== source.id) {
      issue(["bookingComponents", i], "Component provenance must match its exact source snapshot");
    }
    if (component.scheduleFingerprint !== null && source.journeys.some((j) => j.segments.some((s) => s.operatingCarrier === null || s.operatingFlightNumber === null))) {
      issue(["bookingComponents", i, "scheduleFingerprint"], "Incomplete operating identity requires a null fingerprint");
    }
    if (component.payment.kind === "cash" && (component.payment.amount.currency !== source.totalPrice.currency || compareMoney(component.payment.amount, source.totalPrice) !== 0)) {
      issue(["bookingComponents", i, "payment"], "Cash payment must equal the selected offer's inclusive total");
    }
  });
  const used = components.map(() => [] as string[]);
  const sourceJourneyTargets = components.map(() => new Map<number, number>());
  const firstUse: number[] = [];
  let previous: Segment | undefined;
  plan.journeys.forEach((journey, ji) => {
    journey.segments.forEach((ref, si) => {
      const segment = segmentFor(plan, ref);
      if (!segment) { issue(["journeys", ji, "segments", si], "Unresolved source segment reference"); return; }
      if (!firstUse.includes(ref.componentIndex)) firstUse.push(ref.componentIndex);
      used[ref.componentIndex].push(`${ref.journeyIndex}:${ref.segmentIndex}`);
      const targets = sourceJourneyTargets[ref.componentIndex];
      const target = targets.get(ref.journeyIndex);
      if (target !== undefined && target !== ji) issue(["journeys", ji], "A source journey cannot be split across trip journeys");
      targets.set(ref.journeyIndex, ji);
      if (previous && Date.parse(segment.departureAt) < Date.parse(previous.arrivalAt)) issue(["journeys", ji, "segments", si], "Trip travel cannot overlap or reverse chronology");
      previous = segment;
      if (si === 0 && segment.origin !== journey.requestedOrigin) issue(["journeys", ji, "requestedOrigin"], "Requested origin must match the complete traveled journey");
      if (si === journey.segments.length - 1 && segment.destination !== journey.requestedDestination) issue(["journeys", ji, "requestedDestination"], "Requested destination must match the complete traveled journey");
    });
  });
  if (firstUse.some((index, i) => index !== i)) issue(["bookingComponents"], "Components must be ordered by explicit first use in the travel path");
  components.forEach((component, i) => {
    const source = plan.sourceOffers[component.sourceOfferIndex];
    if (!source) return;
    const expected = source.journeys.flatMap((j, ji) => j.segments.map((_, si) => `${ji}:${si}`));
    if (JSON.stringify(expected) !== JSON.stringify(used[i])) issue(["bookingComponents", i], "Every selected source segment must be flown exactly once in source order");
    const targets = [...sourceJourneyTargets[i].values()];
    if (new Set(targets).size !== targets.length) issue(["journeys"], "Distinct source journeys must retain distinct trip journey boundaries");
  });
  const factKeys = new Set<string>();
  plan.protectionFacts.forEach((fact, i) => {
    const refs = plan.journeys[fact.journeyIndex]?.segments;
    const a = refs?.[fact.fromSegmentIndex];
    const b = refs?.[fact.fromSegmentIndex + 1];
    const key = `${fact.journeyIndex}:${fact.fromSegmentIndex}`;
    if (factKeys.has(key) || !a || !b || a.componentIndex !== b.componentIndex) issue(["protectionFacts", i], "Evidence must identify one unique within-component connection");
    factKeys.add(key);
  });
  try { summarizePayments(components.map((c) => c.payment)); }
  catch { issue(["bookingComponents"], "Payment aggregation exceeds the supported exact amount range"); }
});
export type TripPlan = z.infer<typeof TripPlanSchema>;

export const TripTravelSummarySchema = z.strictObject({
  journeys: z.tuple([TripJourneyPlanSchema.extend({
    departureAt: TimestampSchema, arrivalAt: TimestampSchema, durationMilliseconds: MillisecondsSchema,
  })]).rest(TripJourneyPlanSchema.extend({
    departureAt: TimestampSchema, arrivalAt: TimestampSchema, durationMilliseconds: MillisecondsSchema,
  })),
  firstDepartureAt: TimestampSchema, finalArrivalAt: TimestampSchema,
  // Sum of journey elapsed durations; excludes destination stays.
  durationMilliseconds: MillisecondsSchema,
  segmentCount: z.number().int().positive(), bookingComponentCount: z.number().int().positive(),
});
export type TripTravelSummary = z.infer<typeof TripTravelSummarySchema>;

const TripBaseSchema = z.strictObject({
  id: IdSchema,
  sourceOffers: z.tuple([TripSourceSnapshotSchema]).rest(TripSourceSnapshotSchema),
  bookingComponents: planShape.bookingComponents,
  travel: TripTravelSummarySchema,
  payment: TripPaymentSummarySchema,
  connections: z.array(ConnectionSchema),
  warnings: z.array(TripWarningSchema),
});
type TripData = z.infer<typeof TripBaseSchema>;

function deriveTrip(plan: TripPlan): TripData {
  const connections: Connection[] = [];
  const journeys = plan.journeys.map((journey, ji) => {
    const segments = journey.segments.map((ref) => segmentFor(plan, ref)!);
    segments.forEach((segment, si) => {
      if (si === 0) return;
      const prior = segments[si - 1];
      const from = journey.segments[si - 1].componentIndex;
      const to = journey.segments[si].componentIndex;
      const crosses = from !== to;
      const fact = plan.protectionFacts.find((f) => f.journeyIndex === ji && f.fromSegmentIndex === si - 1);
      const component = plan.bookingComponents[from];
      connections.push({
        journeyIndex: ji, fromSegmentIndex: si - 1, fromComponentIndex: from, toComponentIndex: to,
        arrivalAirport: prior.destination, departureAirport: segment.origin,
        arrivalAt: new Date(prior.arrivalAt).toISOString(), departureAt: new Date(segment.departureAt).toISOString(),
        durationMilliseconds: Date.parse(segment.departureAt) - Date.parse(prior.arrivalAt),
        airportChange: prior.destination !== segment.origin, crossesBookingBoundary: crosses,
        protection: crosses ? "self_transfer" : fact?.protection ?? "unknown",
        evidence: crosses ? { kind: "separate_bookings" } : fact ? {
          kind: "provider", provider: component.provider, providerOfferId: component.providerOfferId, reference: fact.reference,
        } : { kind: "unknown" },
      });
    });
    const first = segments[0];
    const last = segments[segments.length - 1];
    return { ...journey, departureAt: new Date(first.departureAt).toISOString(), arrivalAt: new Date(last.arrivalAt).toISOString(),
      durationMilliseconds: Date.parse(last.arrivalAt) - Date.parse(first.departureAt) };
  }) as TripTravelSummary["journeys"];
  const warnings: TripWarning[] = [];
  if (connections.some((c) => c.protection === "self_transfer") || plan.sourceOffers.some((o) => o.warnings.includes("self_transfer"))) warnings.push("self_transfer");
  if (plan.bookingComponents.length > 1) warnings.push("multiple_booking_components");
  if (connections.some((c) => c.airportChange)) warnings.push("airport_change");
  const kinds = plan.bookingComponents.map((c) => c.payment.kind);
  if (new Set(kinds).size > 1 || kinds.includes("cash_and_points")) warnings.push("mixed_payment");
  if (connections.some((c) => c.protection === "unknown")) warnings.push("unknown_connection_protection");
  return {
    id: plan.id, sourceOffers: plan.sourceOffers.map(tripSourceSnapshot) as [TripSourceSnapshot, ...TripSourceSnapshot[]], bookingComponents: plan.bookingComponents,
    travel: { journeys, firstDepartureAt: journeys[0].departureAt, finalArrivalAt: journeys[journeys.length - 1].arrivalAt,
      durationMilliseconds: journeys.reduce((sum, j) => sum + j.durationMilliseconds, 0),
      segmentCount: journeys.reduce((sum, j) => sum + j.segments.length, 0), bookingComponentCount: plan.bookingComponents.length },
    payment: summarizePayments(plan.bookingComponents.map((c) => c.payment)), connections, warnings,
  };
}

export const TripOptionSchema = TripBaseSchema.superRefine((trip, ctx) => {
  if (!TripBaseSchema.safeParse(trip).success) return;
  // Projections retain all facts used by the existing plan validator. Its absent
  // metadata default is internal; deriveTrip emits only allowlisted fields again.
  const parsed = TripPlanSchema.safeParse({
    id: trip.id, sourceOffers: trip.sourceOffers, bookingComponents: trip.bookingComponents,
    journeys: trip.travel.journeys.map(({ requestedOrigin, requestedDestination, segments }) => ({ requestedOrigin, requestedDestination, segments })),
    protectionFacts: trip.connections.filter((c) => c.evidence.kind === "provider").map((c) => ({
      journeyIndex: c.journeyIndex, fromSegmentIndex: c.fromSegmentIndex, protection: c.protection,
      reference: c.evidence.kind === "provider" ? c.evidence.reference : "",
    })),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path[0] === "journeys" ? ["travel", ...issue.path] : issue.path, message: issue.message });
    return;
  }
  const expected = deriveTrip(parsed.data);
  for (const field of ["travel", "payment", "connections", "warnings"] as const) {
    if (JSON.stringify(trip[field]) !== JSON.stringify(expected[field])) ctx.addIssue({ code: "custom", path: [field], message: `${field} must match centrally derived source facts` });
  }
});
export type TripOption = z.infer<typeof TripOptionSchema>;

// Accepts an explicitly selected plan, never discovers or optimizes routes.
export function createTripOption(plan: TripPlan): TripOption {
  return TripOptionSchema.parse(deriveTrip(TripPlanSchema.parse(plan)));
}
