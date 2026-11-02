import { z } from "zod";
import {
  AirportCodeSchema, FlightOfferSchema, SupportedCurrencyCodeSchema, TimestampSchema,
  type FlightOffer,
} from "@flightbrain/domain";
import {
  CommercialRequestDescriptorSchema, CommercialResolutionSchema,
  type CommercialRequestDescriptor, type CommercialResolution,
} from "./resolution";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const CountSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// MockIntakePolicy
// ---------------------------------------------------------------------------

export const MockIntakePolicySchema = z.strictObject({
  asOf: TimestampSchema,
  seed: CountSchema,
  offersPerDescriptor: CountSchema.max(20),
  // Bounded (<= ~1 year) so an absurd value surfaces as a ZodError at the parse
  // boundary rather than a RangeError from Date#toISOString on overflow.
  offerValidityMs: CountSchema.max(31_536_000_000),
  currency: SupportedCurrencyCodeSchema,
});
export type MockIntakePolicy = z.infer<typeof MockIntakePolicySchema>;

// ---------------------------------------------------------------------------
// SyntheticProvenance
// ---------------------------------------------------------------------------

export const SyntheticProvenanceSchema = z.strictObject({
  providerId: z.string().regex(/^mock:/, "Synthetic provider IDs must use the 'mock:' namespace"),
  synthetic: z.literal(true),
  disclaimer: z.string().min(1).refine(
    (s) => s.trim().length > 0,
    "Disclaimer must be a non-blank string",
  ),
});
export type SyntheticProvenance = z.infer<typeof SyntheticProvenanceSchema>;

// ---------------------------------------------------------------------------
// MockOfferRejectionReason
// ---------------------------------------------------------------------------

export const MockOfferRejectionReasonSchema = z.enum([
  "departure_not_concrete",
  "route_filter_unsupported",
  "passengers_unresolved",
]);
export type MockOfferRejectionReason = z.infer<typeof MockOfferRejectionReasonSchema>;

// ---------------------------------------------------------------------------
// MockIntakeOutcome (discriminated union)
// ---------------------------------------------------------------------------

export const MockIntakeOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("offered"),
    jobId: CountSchema,
    offers: z.array(FlightOfferSchema),
  }),
  z.strictObject({
    outcome: z.literal("declined"),
    jobId: CountSchema,
    reason: MockOfferRejectionReasonSchema,
  }),
]);
export type MockIntakeOutcome = z.infer<typeof MockIntakeOutcomeSchema>;

// ---------------------------------------------------------------------------
// MockIntakeResult (with superRefine invariant mirroring resolution.ts)
// ---------------------------------------------------------------------------

const MockIntakeResultBaseSchema = z.strictObject({
  kind: z.literal("mock_intake"),
  requestId: z.string().min(1),
  outcomes: z.array(MockIntakeOutcomeSchema),
  offeredJobIds: z.array(CountSchema),
  diagnostics: z.array(z.string()),
});

export const MockIntakeResultSchema = MockIntakeResultBaseSchema.superRefine((result, ctx) => {
  if (!MockIntakeResultBaseSchema.safeParse(result).success) return;
  const offeredFromOutcomes = result.outcomes
    .filter((o) => o.outcome === "offered")
    .map((o) => o.jobId);
  if (JSON.stringify(result.offeredJobIds) !== JSON.stringify(offeredFromOutcomes)) {
    ctx.addIssue({
      code: "custom",
      message: "offeredJobIds must be exactly the offered outcomes' jobIds in order",
    });
  }
});
export type MockIntakeResult = z.infer<typeof MockIntakeResultSchema>;

// ---------------------------------------------------------------------------
// Deterministic PRNG (splitmix32 seeded with FNV-1a over canonical JSON)
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash over a UTF-8 string.
 * No external state; entirely deterministic.
 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Handle multi-byte chars by encoding individual bytes
    for (let byte = code; byte > 0; byte >>= 8) {
      hash ^= byte & 0xff;
      // Multiply by FNV prime 0x01000193, keeping to 32-bit
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

/**
 * Splitmix32 — advances one step and returns a value in [0, 1).
 * Returns [nextState, value] for purely functional use.
 */
function splitmix32Step(state: number): [number, number] {
  state = (state + 0x9e3779b9) | 0;
  let z = state;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  z = z ^ (z >>> 16);
  const value = (z >>> 0) / 0x100000000;
  return [state >>> 0, value];
}

/** Derive a deterministic seed from the canonical descriptor JSON + jobId + offerIndex + policy seed. */
function deriveSeed(descriptor: CommercialRequestDescriptor, offerIndex: number, policySeed: number): number {
  const key = JSON.stringify(CommercialRequestDescriptorSchema.parse(descriptor)) +
    `:offer:${offerIndex}:seed:${policySeed}`;
  return fnv1a32(key);
}

/** Generate `count` pseudo-random values for one (descriptor, offerIndex, seed) triple. */
function prngSequence(descriptor: CommercialRequestDescriptor, offerIndex: number, policySeed: number, count: number): number[] {
  let state = deriveSeed(descriptor, offerIndex, policySeed);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const [nextState, value] = splitmix32Step(state);
    state = nextState;
    values.push(value);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Timestamp utilities (all derived from policy.asOf — no wall clock)
// ---------------------------------------------------------------------------

/** Add milliseconds to an RFC 3339 timestamp, returning a new RFC 3339 timestamp. */
function addMs(timestamp: string, ms: number): string {
  const base = Date.parse(timestamp);
  // Format as ISO 8601 with Z suffix (UTC). All internal timestamps are UTC.
  return new Date(base + ms).toISOString();
}

/** Produce an ISO 8601 UTC timestamp with millisecond precision. */
function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Carrier/flight-number generation (deterministic, clearly synthetic)
// ---------------------------------------------------------------------------

// Synthetic two-letter carrier code prefix — clearly not a real IATA code.
const SYNTHETIC_CARRIERS = ["ZZ", "ZY", "ZX", "ZW", "ZV"] as const;

function syntheticCarrier(rand: number): string {
  return SYNTHETIC_CARRIERS[Math.floor(rand * SYNTHETIC_CARRIERS.length)];
}

function syntheticFlightNumber(rand: number): string {
  // Range 100–999 to keep it flight-number-shaped without implying a real flight.
  return String(100 + Math.floor(rand * 900));
}

// ---------------------------------------------------------------------------
// Offer ID generation (deterministic, no random)
// ---------------------------------------------------------------------------

function syntheticOfferId(
  providerId: string,
  jobId: number,
  offerIndex: number,
  descriptor: CommercialRequestDescriptor,
): string {
  const key = `${providerId}:job:${jobId}:offer:${offerIndex}:route:${descriptor.routeFilter.join("-")}`;
  return `mock-offer-${fnv1a32(key).toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Single-offer synthesis
// ---------------------------------------------------------------------------

/**
 * Synthesise one FlightOffer for a resolved descriptor. All timestamps derive
 * from policy.asOf only; entirely deterministic, no stdlib random or wall-clock.
 */
function synthesizeOffer(
  descriptor: CommercialRequestDescriptor,
  offerIndex: number,
  policy: MockIntakePolicy,
  provenance: SyntheticProvenance,
): FlightOffer {
  // routeFilter gives the exact airport sequence; segments mirror it exactly.
  const airports = descriptor.routeFilter; // e.g. ["DEL","NRT","SFO"]
  const segmentCount = airports.length - 1;

  // departure date from the descriptor
  // descriptor.departure.kind === "date" is guaranteed before we call this function
  const departureDate = (descriptor.departure as { kind: "date"; date: string }).date;

  // Base departure time (UTC): date at 08:00:00.000Z, deterministically offset by offerIndex.
  const baseDepartureMs = Date.parse(`${departureDate}T08:00:00.000Z`);

  // Derive random values for this offer (carrier, flight number, durations).
  // We need 3 values per segment: carrier, flight number, duration.
  const rands = prngSequence(descriptor, offerIndex, policy.seed, segmentCount * 3 + 2);
  let ri = 0;

  // Per-offer departure offset: 0-6h spread across offers.
  const departureOffsetMs = Math.floor(rands[ri++] * 6 * 60 * 60 * 1000);
  // Per-offer price variation: ±30% around a base price.
  const priceVariation = 0.7 + rands[ri++] * 0.6;

  let segmentDepartureMs = baseDepartureMs + departureOffsetMs;

  const segments = airports.slice(0, -1).map((origin, segIdx) => {
    const destination = airports[segIdx + 1];
    const carrier = syntheticCarrier(rands[ri++]);
    const flightNum = syntheticFlightNumber(rands[ri++]);
    // Flight duration: 2h to 14h (120min - 840min)
    const durationMs = (120 + Math.floor(rands[ri++] * 720)) * 60_000;

    const depMs = segmentDepartureMs;
    const arrMs = depMs + durationMs;

    // If not the last segment, add a layover of 2h before next departure.
    segmentDepartureMs = arrMs + 2 * 60 * 60_000;

    return {
      origin,
      destination,
      departureAt: isoFromMs(depMs),
      arrivalAt: isoFromMs(arrMs),
      marketingCarrier: carrier,
      marketingFlightNumber: flightNum,
      operatingCarrier: null,
      operatingFlightNumber: null,
      cabin: "economy" as const,
    };
  });

  // Synthetic price: a deterministic, currency-AGNOSTIC noise magnitude (minor units)
  // scaled per segment with per-offer variation. It is NOT a real fare and is not
  // scaled to the currency's exponent — the honest currency label on totalPrice is
  // what matters; the magnitude carries no authority (requiresRevalidation stays true).
  const basePriceMinor = BigInt(segmentCount * 20000);
  const totalMinor = BigInt(Math.round(Number(basePriceMinor) * priceVariation));

  const retrievedAt = policy.asOf;
  const expiresAt = policy.offerValidityMs > 0 ? addMs(policy.asOf, policy.offerValidityMs) : null;

  // Idempotent synthetic offer ID.
  const offerId = syntheticOfferId(provenance.providerId, descriptor.jobId, offerIndex, descriptor);

  return FlightOfferSchema.parse({
    id: offerId,
    journeys: [{ segments }],
    provider: provenance.providerId,
    providerOfferId: offerId,
    bookingUrl: null,
    retrievedAt,
    expiresAt,
    requiresRevalidation: true,
    providerMetadata: {
      synthetic: true,
      disclaimer: provenance.disclaimer,
      seedUsed: policy.seed,
      offerIndex,
    },
    totalPrice: {
      amountMinor: totalMinor.toString(),
      currency: policy.currency,
      exponent: policy.currency === "JPY" ? 0 : policy.currency === "KWD" ? 3 : 2,
    },
    refundable: null,
    changeable: null,
    checkedBags: null,
    cabinBags: null,
    warnings: [],
  });
}

// ---------------------------------------------------------------------------
// Public API: intakeMockOffers
// ---------------------------------------------------------------------------

/**
 * Pure function: one CommercialRequestDescriptor + policy + provenance → MockIntakeOutcome.
 * Strict-parses all three inputs at the boundary (clones untrusted input).
 * Deterministic: no wall-clock, no pseudo-random stdlib, no network, no mutation.
 */
export function intakeMockOffers(
  rawDescriptor: unknown,
  rawPolicy: unknown,
  rawProvenance: unknown,
): MockIntakeOutcome {
  // Parse all inputs at the boundary — clones and validates every field.
  const descriptor = CommercialRequestDescriptorSchema.parse(rawDescriptor);
  const policy = MockIntakePolicySchema.parse(rawPolicy);
  const provenance = SyntheticProvenanceSchema.parse(rawProvenance);

  const jobId = descriptor.jobId;

  // Rule: non-"date" departure → declined/departure_not_concrete.
  if (descriptor.departure.kind !== "date") {
    return MockIntakeOutcomeSchema.parse({
      outcome: "declined",
      jobId,
      reason: "departure_not_concrete",
    });
  }

  // Rule: passengers null → declined/passengers_unresolved.
  if (descriptor.passengers === null) {
    return MockIntakeOutcomeSchema.parse({
      outcome: "declined",
      jobId,
      reason: "passengers_unresolved",
    });
  }

  // Rule: route depth beyond synthesis capacity. We support up to 5 airports (4 segments).
  if (descriptor.routeFilter.length > 5) {
    return MockIntakeOutcomeSchema.parse({
      outcome: "declined",
      jobId,
      reason: "route_filter_unsupported",
    });
  }

  // Synthesize offers deterministically.
  const offers: FlightOffer[] = [];
  for (let i = 0; i < policy.offersPerDescriptor; i++) {
    offers.push(synthesizeOffer(descriptor, i, policy, provenance));
  }

  return MockIntakeOutcomeSchema.parse({
    outcome: "offered",
    jobId,
    offers,
  });
}

// ---------------------------------------------------------------------------
// Public API: intakeMockResult
// ---------------------------------------------------------------------------

/**
 * Batch fold: CommercialResolution → MockIntakeResult.
 * Preserves requestId + order. Filters to resolved descriptors only.
 */
export function intakeMockResult(
  rawResolution: unknown,
  rawPolicy: unknown,
  rawProvenance: unknown,
): MockIntakeResult {
  const resolution = CommercialResolutionSchema.parse(rawResolution);
  const policy = MockIntakePolicySchema.parse(rawPolicy);
  const provenance = SyntheticProvenanceSchema.parse(rawProvenance);

  const outcomes: MockIntakeOutcome[] = [];
  const offeredJobIds: number[] = [];
  const diagnostics: string[] = [];

  for (const decision of resolution.decisions) {
    if (decision.outcome !== "resolved") continue;

    const outcome = intakeMockOffers(decision.descriptor, policy, provenance);
    outcomes.push(outcome);

    if (outcome.outcome === "offered") {
      offeredJobIds.push(outcome.jobId);
    } else {
      if (!diagnostics.includes(outcome.reason)) {
        diagnostics.push(outcome.reason);
      }
    }
  }

  return MockIntakeResultSchema.parse({
    kind: "mock_intake",
    requestId: resolution.requestId,
    outcomes,
    offeredJobIds,
    diagnostics,
  });
}
