import { z } from "zod";
import { AirportCodeSchema, DurationMinutesSchema, TimestampSchema } from "@flightbrain/domain";

const CountSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const VerifiedPrefixArrivalFactSchema = z.strictObject({
  candidateIndex: CountSchema,
  precedingLegIndex: CountSchema,
  arrivalAirport: AirportCodeSchema,
  arrivalAt: TimestampSchema,
  evidenceLevel: z.enum(["scheduled", "observed"]),
  provenance: z.strictObject({
    sourceId: z.string(),
    observedAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
  }).nullable(),
});
export type VerifiedPrefixArrivalFact = z.infer<typeof VerifiedPrefixArrivalFactSchema>;

export const DependentDepartureFactSchema = z.strictObject({
  candidateIndex: CountSchema,
  legIndex: CountSchema,
  departureAirport: AirportCodeSchema,
  earliestDepartureAt: TimestampSchema,
  evidenceLevel: z.enum(["scheduled", "observed"]),
});
export type DependentDepartureFact = z.infer<typeof DependentDepartureFactSchema>;

export const ConnectionPolicySchema = z.strictObject({
  minConnectionMinutes: DurationMinutesSchema,
  allowAirportChange: z.boolean(),
  airportChangeTransferMinutes: DurationMinutesSchema.nullable(),
  rolloverReference: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("utc_instant") }),
    z.strictObject({ kind: z.literal("fixed_offset_minutes"), offsetMinutes: z.number().int() }),
  ]),
});
export type ConnectionPolicy = z.infer<typeof ConnectionPolicySchema>;

// ---------------------------------------------------------------------------
// Reason / decision schemas
// ---------------------------------------------------------------------------

export const ConnectionFeasibilityReasonSchema = z.enum([
  "below_minimum_connection",
  "negative_gap",
  "airport_change_disallowed",
  "meets_minimum_connection",
  "same_airport",
  "airport_change_allowed",
  "day_rollover",
  "no_day_rollover",
  "missing_transfer_time",
  "dependency_mismatch",
]);
export type ConnectionFeasibilityReason = z.infer<typeof ConnectionFeasibilityReasonSchema>;

// Stable canonical reason order (preserves a fixed array order regardless of insertion).
const REASON_ORDER: readonly ConnectionFeasibilityReason[] = [
  "dependency_mismatch",
  "missing_transfer_time",
  "negative_gap",
  "below_minimum_connection",
  "airport_change_disallowed",
  "meets_minimum_connection",
  "same_airport",
  "airport_change_allowed",
  "day_rollover",
  "no_day_rollover",
];

function sortedReasons(reasons: ConnectionFeasibilityReason[]): ConnectionFeasibilityReason[] {
  const seen = new Set<ConnectionFeasibilityReason>();
  const out: ConnectionFeasibilityReason[] = [];
  for (const r of REASON_ORDER) {
    if (reasons.includes(r) && !seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out;
}

// Feasible reasons: at least one of these must be present and no infeasible/unknown-only reasons.
const FEASIBLE_REASONS: ReadonlySet<ConnectionFeasibilityReason> = new Set([
  "meets_minimum_connection", "same_airport", "airport_change_allowed", "day_rollover", "no_day_rollover",
]);
// Infeasible reasons: at least one must be present for infeasible status.
const INFEASIBLE_REASONS: ReadonlySet<ConnectionFeasibilityReason> = new Set([
  "below_minimum_connection", "negative_gap", "airport_change_disallowed",
]);
// Unknown reasons: indicate missing data.
const UNKNOWN_REASONS: ReadonlySet<ConnectionFeasibilityReason> = new Set([
  "missing_transfer_time", "dependency_mismatch",
]);

const ReasonsSchema = z.array(ConnectionFeasibilityReasonSchema).min(1);

const FeasibleDecisionSchema = z.strictObject({
  status: z.literal("feasible"),
  gapMinutes: z.number(),
  airportRelation: z.enum(["same_airport", "airport_change"]),
  splitTicket: z.literal(true),
  dayRollover: z.boolean(),
  reasons: ReasonsSchema,
});

const InfeasibleDecisionSchema = z.strictObject({
  status: z.literal("infeasible"),
  gapMinutes: z.number().nullable(),
  reasons: ReasonsSchema,
});

const UnknownDecisionSchema = z.strictObject({
  status: z.literal("unknown"),
  reasons: ReasonsSchema,
});

export const ConnectionFeasibilityDecisionSchema = z.discriminatedUnion("status", [
  FeasibleDecisionSchema,
  InfeasibleDecisionSchema,
  UnknownDecisionSchema,
]).superRefine((decision, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const reasons = decision.reasons as ConnectionFeasibilityReason[];

  const hasUnknown = reasons.some(r => UNKNOWN_REASONS.has(r));
  const hasFeasible = reasons.some(r => FEASIBLE_REASONS.has(r));
  const hasInfeasible = reasons.some(r => INFEASIBLE_REASONS.has(r));

  // Stability: reasons must be in canonical order without duplicates.
  const canonicalOrder = sortedReasons(reasons);
  if (JSON.stringify(reasons) !== JSON.stringify(canonicalOrder)) {
    issue("Reasons must appear in stable canonical order without duplicates");
  }

  if (decision.status === "feasible") {
    if (hasUnknown) issue("Feasible decision must not include unknown-category reasons");
    if (hasInfeasible) issue("Feasible decision must not include infeasible-category reasons");
    if (!hasFeasible) issue("Feasible decision must include at least one feasible-category reason");
  } else if (decision.status === "infeasible") {
    if (hasUnknown) issue("Infeasible decision must not include unknown-category reasons");
    if (!hasInfeasible) issue("Infeasible decision must include at least one infeasible-category reason");
  } else {
    // unknown
    if (!hasUnknown) issue("Unknown decision must include at least one unknown-category reason");
    if (hasFeasible) issue("Unknown decision must not include feasible-category reasons");
    if (hasInfeasible) issue("Unknown decision must not include infeasible-category reasons");
  }
});
export type ConnectionFeasibilityDecision = z.infer<typeof ConnectionFeasibilityDecisionSchema>;

// ---------------------------------------------------------------------------
// Pure evaluation function
// ---------------------------------------------------------------------------

/**
 * Evaluates one connection boundary (verified-prefix arrival -> dependent-span departure).
 * Pure: no I/O, no Date.now/Math.random, no invented thresholds.
 * Missing inputs => unknown; never invents MCT/timezone/rollover thresholds.
 */
export function evaluateConnectionFeasibility(
  rawArrival: VerifiedPrefixArrivalFact,
  rawDeparture: DependentDepartureFact,
  rawPolicy: ConnectionPolicy,
): ConnectionFeasibilityDecision {
  // Parse through schemas to normalize and validate all three inputs.
  const arrival = VerifiedPrefixArrivalFactSchema.parse(rawArrival);
  const departure = DependentDepartureFactSchema.parse(rawDeparture);
  const policy = ConnectionPolicySchema.parse(rawPolicy);

  const reasons: ConnectionFeasibilityReason[] = [];

  // Rule 1: dependency mismatch
  // arrival.precedingLegIndex + 1 must equal departure.legIndex, candidateIndex must match.
  if (arrival.candidateIndex !== departure.candidateIndex ||
    arrival.precedingLegIndex + 1 !== departure.legIndex) {
    return ConnectionFeasibilityDecisionSchema.parse({
      status: "unknown",
      reasons: sortedReasons(["dependency_mismatch"]),
    });
  }

  // Rule 2: evidence/presence floors — intentionally none beyond the schema.
  // VerifiedPrefixArrivalFact/DependentDepartureFact already require non-null instants
  // and constrain evidenceLevel to {scheduled, observed}, so there is no additional
  // "missing instant"/"insufficient evidence" state to detect here. We do NOT invent an
  // evidence bar the contract does not define (and departure facts carry no provenance),
  // so the only unknown reasons this function emits are dependency_mismatch and
  // missing_transfer_time below.

  // Rule 3: airport relation
  const sameAirport = arrival.arrivalAirport === departure.departureAirport;
  const airportRelation: "same_airport" | "airport_change" = sameAirport ? "same_airport" : "airport_change";

  if (!sameAirport && !policy.allowAirportChange) {
    return ConnectionFeasibilityDecisionSchema.parse({
      status: "infeasible",
      gapMinutes: null,
      reasons: sortedReasons(["airport_change_disallowed"]),
    });
  }

  if (!sameAirport && policy.allowAirportChange && policy.airportChangeTransferMinutes === null) {
    return ConnectionFeasibilityDecisionSchema.parse({
      status: "unknown",
      reasons: sortedReasons(["missing_transfer_time"]),
    });
  }

  // Rule 4: gap computation
  const arrivalMs = Date.parse(arrival.arrivalAt);
  const departureMs = Date.parse(departure.earliestDepartureAt);
  const gapMs = departureMs - arrivalMs;
  const gapMinutes = Math.floor(gapMs / 60_000);

  if (gapMinutes < 0) {
    return ConnectionFeasibilityDecisionSchema.parse({
      status: "infeasible",
      gapMinutes,
      reasons: sortedReasons(["negative_gap"]),
    });
  }

  const transferMinutes = sameAirport ? 0 : (policy.airportChangeTransferMinutes ?? 0);
  const requiredMinutes = policy.minConnectionMinutes + transferMinutes;

  if (gapMinutes < requiredMinutes) {
    return ConnectionFeasibilityDecisionSchema.parse({
      status: "infeasible",
      gapMinutes,
      reasons: sortedReasons(["below_minimum_connection"]),
    });
  }

  // Rule 5: day rollover (computed only on the feasible path for reference, NEVER alters verdict)
  const dayRollover = computeDayRollover(arrival.arrivalAt, departure.earliestDepartureAt, policy.rolloverReference);
  const rolloverReason: ConnectionFeasibilityReason = dayRollover ? "day_rollover" : "no_day_rollover";

  // Feasible
  if (sameAirport) {
    reasons.push("same_airport");
  } else {
    reasons.push("airport_change_allowed");
  }
  reasons.push("meets_minimum_connection");
  reasons.push(rolloverReason);

  return ConnectionFeasibilityDecisionSchema.parse({
    status: "feasible",
    gapMinutes,
    airportRelation,
    splitTicket: true,
    dayRollover,
    reasons: sortedReasons(reasons),
  });
}

// ---------------------------------------------------------------------------
// Day rollover helper
// ---------------------------------------------------------------------------

/**
 * Returns true if arrivalAt and earliestDepartureAt fall on different calendar days
 * under the rolloverReference. NEVER invents offsets; uses only what is supplied.
 */
function computeDayRollover(
  arrivalAt: string,
  departureAt: string,
  rolloverReference: ConnectionPolicy["rolloverReference"],
): boolean {
  const arrivalMs = Date.parse(arrivalAt);
  const departureMs = Date.parse(departureAt);

  let offsetMs: number;
  if (rolloverReference.kind === "utc_instant") {
    offsetMs = 0;
  } else {
    // fixed_offset_minutes: positive = east of UTC
    offsetMs = rolloverReference.offsetMinutes * 60_000;
  }

  const arrivalDay = Math.floor((arrivalMs + offsetMs) / 86_400_000);
  const departureDay = Math.floor((departureMs + offsetMs) / 86_400_000);
  return departureDay > arrivalDay;
}
