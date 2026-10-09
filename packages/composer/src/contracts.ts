import { z } from "zod";
import {
  AirportCodeSchema, RouteCandidateSchema, RouteDiscoveryRequestSchema, TimestampSchema,
  type RouteCandidate, type RouteEvidence,
} from "@flightbrain/domain";

const CountSchema = z.number().int().nonnegative();
export const VerificationPlanningPolicySchema = z.strictObject({
  asOf: TimestampSchema,
  maxCandidateAgeMs: CountSchema,
  maxCandidates: CountSchema.max(1_000),
  maxLegsPerCandidate: CountSchema.max(32),
  maxJobs: CountSchema.max(10_000),
});
export type VerificationPlanningPolicy = z.infer<typeof VerificationPlanningPolicySchema>;

export const CandidatePlanningReasonSchema = z.enum([
  "invalid_candidate", "leg_limit", "request_mismatch", "unsupported_movement",
  "disconnected_route", "cyclic_route", "endpoint_mismatch", "stop_limit",
  "future_candidate", "stale_candidate", "unusable_route_evidence",
]);
export type CandidatePlanningReason = z.infer<typeof CandidatePlanningReasonSchema>;

// Canonical investigation intent, still requiring trusted execution eligibility.
export const VerificationRequestIntentSchema = z.strictObject({
  airports: z.array(AirportCodeSchema).min(2),
  departure: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("request_intent"), intent: RouteDiscoveryRequestSchema.shape.departure }),
    z.strictObject({ kind: z.literal("after_verified_arrival"), candidateIndex: CountSchema, precedingLegIndex: CountSchema }),
  ]),
  // Preserve discovery party intent; never infer ages, adults or commercial eligibility.
  passengers: RouteDiscoveryRequestSchema.shape.passengers,
});
export type VerificationRequestIntent = z.infer<typeof VerificationRequestIntentSchema>;

export const VerificationSourceBindingSchema = z.strictObject({
  candidateIndex: CountSchema,
  fromLegIndex: CountSchema,
  toLegIndex: CountSchema, // Inclusive; never slices or renumbers the source evidence.
  routeEvidenceIndices: z.array(CountSchema).min(1),
});
export type VerificationSourceBinding = z.infer<typeof VerificationSourceBindingSchema>;
export const VerificationJobSchema = z.strictObject({
  id: CountSchema,
  requestIntent: VerificationRequestIntentSchema,
  sourceBindings: z.array(VerificationSourceBindingSchema).min(1),
});
export type VerificationJob = z.infer<typeof VerificationJobSchema>;

// Strict schema parsing fixes object-key order at every level and includes every
// intent field. Keys are local to one request/plan, never durable execution IDs.
export function verificationIntentKey(intent: VerificationRequestIntent): string {
  return JSON.stringify(VerificationRequestIntentSchema.parse(intent));
}

const CandidateDecisionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("skipped"), candidateIndex: CountSchema, reason: CandidatePlanningReasonSchema }),
  z.strictObject({ status: z.literal("eligible"), candidateIndex: CountSchema, candidate: RouteCandidateSchema }),
]);

export function airportPath(candidate: RouteCandidate, start = 0, end = candidate.legs.length - 1): string[] | null {
  if (start < 0 || end < start || end >= candidate.legs.length) return null;
  const path: string[] = [];
  for (let i = start; i <= end; i++) {
    const leg = candidate.legs[i];
    if (leg.mode !== "flight" || leg.role !== "travel" || leg.order !== i ||
      leg.origin.kind !== "airport" || leg.destination.kind !== "airport") return null;
    if (i === start) path.push(leg.origin.iataCode);
    else if (path.at(-1) !== leg.origin.iataCode) return null;
    path.push(leg.destination.iataCode);
  }
  return path;
}

export function usableRouteEvidence(fact: RouteEvidence, asOf: number): boolean {
  return fact.factType === "route_exists" && fact.target.kind === "leg" &&
    (fact.observedAt === null || Date.parse(fact.observedAt) <= asOf) &&
    (fact.expiresAt === null || Date.parse(fact.expiresAt) > asOf);
}

const PlanBaseSchema = z.strictObject({
  kind: z.literal("verification_plan"),
  requestId: RouteDiscoveryRequestSchema.shape.requestId,
  policy: VerificationPlanningPolicySchema,
  inputCandidateCount: CountSchema,
  unexaminedCandidateCount: CountSchema,
  decisions: z.array(CandidateDecisionSchema),
  jobs: z.array(VerificationJobSchema),
  diagnostics: z.array(z.enum(["unsupported_request_location", "flight_mode_excluded", "candidate_limit", "job_limit"])),
});
export const VerificationPlanSchema = PlanBaseSchema.superRefine((plan, ctx) => {
  if (!PlanBaseSchema.safeParse(plan).success) return;
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (plan.decisions.length > plan.policy.maxCandidates || plan.jobs.length > plan.policy.maxJobs) issue("Plan exceeds its budget");
  if (plan.decisions.length + plan.unexaminedCandidateCount !== plan.inputCandidateCount) issue("Candidate accounting must be complete");
  const eligible = new Map<number, RouteCandidate>();
  plan.decisions.forEach((decision, index) => {
    if (decision.candidateIndex !== index) issue("Decisions must retain input order and occurrence indexes");
    if (decision.status === "eligible") {
      if (decision.candidate.requestId !== plan.requestId) issue("Candidate belongs to a different request");
      if (!airportPath(decision.candidate) || decision.candidate.legs.length > plan.policy.maxLegsPerCandidate) issue("Ineligible candidate snapshot");
      eligible.set(index, decision.candidate);
    }
  });
  const spans = new Set<string>();
  const intents = new Set<string>();
  plan.jobs.forEach((job, index) => {
    if (job.id !== index) issue("Job IDs must be contiguous local indexes");
    const intentKey = verificationIntentKey(job.requestIntent);
    if (intents.has(intentKey)) issue("Exact-equivalent intents must share one job");
    intents.add(intentKey);
    job.sourceBindings.forEach(binding => {
      const candidate = eligible.get(binding.candidateIndex);
      if (!candidate) { issue("Job must reference an eligible candidate occurrence"); return; }
      const path = airportPath(candidate, binding.fromLegIndex, binding.toLegIndex);
      if (!path || JSON.stringify(job.requestIntent.airports) !== JSON.stringify(path)) issue("Job route must match the exact connected source leg range");
      const key = `${binding.candidateIndex}:${binding.fromLegIndex}:${binding.toLegIndex}`;
      if (spans.has(key)) issue("Duplicate span for one candidate occurrence");
      spans.add(key);
      const departure = job.requestIntent.departure;
      if (binding.fromLegIndex === 0 ? departure.kind !== "request_intent" :
        departure.kind !== "after_verified_arrival" || departure.candidateIndex !== binding.candidateIndex ||
        departure.precedingLegIndex !== binding.fromLegIndex - 1) issue("Departure must retain its request or exact occurrence's verified-arrival dependency");
      const expectedEvidence = candidate.evidence.flatMap((fact, i) =>
        usableRouteEvidence(fact, Date.parse(plan.policy.asOf)) && fact.target.kind === "leg" &&
        fact.target.legIndex >= binding.fromLegIndex && fact.target.legIndex <= binding.toLegIndex ? [i] : []);
      if (JSON.stringify(binding.routeEvidenceIndices) !== JSON.stringify(expectedEvidence)) issue("Evidence references must retain original indexes and targets");
      for (let i = binding.fromLegIndex; i <= Math.min(binding.toLegIndex, candidate.legs.length - 1); i++) {
        if (!expectedEvidence.some(index => {
          const target = candidate.evidence[index].target;
          return target.kind === "leg" && target.legIndex === i;
        })) issue("Every planned leg requires usable route evidence");
      }
    });
  });
});
export type VerificationPlan = z.infer<typeof VerificationPlanSchema>;
