import { z } from "zod";
import { RouteDiscoveryRequestSchema, TimestampSchema } from "@flightbrain/domain";
import {
  usableRouteEvidence, verificationIntentKey, VerificationPlanSchema,
  type VerificationPlan,
} from "./contracts";

const CountSchema = z.number().int().nonnegative();

export const ExecutionBudgetSchema = z.strictObject({
  maxProviderIntents: CountSchema.max(10_000),
  alreadyConsumedIntents: CountSchema,
  maxCandidateAgeMs: CountSchema,
});
export type ExecutionBudget = z.infer<typeof ExecutionBudgetSchema>;

export const TrustedExecutionContextSchema = z.strictObject({
  requestId: RouteDiscoveryRequestSchema.shape.requestId,
  asOf: TimestampSchema,
  departure: RouteDiscoveryRequestSchema.shape.departure,
  passengers: RouteDiscoveryRequestSchema.shape.passengers,
  budget: ExecutionBudgetSchema,
});
export type TrustedExecutionContext = z.infer<typeof TrustedExecutionContextSchema>;

export const ExecutionRejectionReasonSchema = z.enum([
  "request_mismatch",
  "departure_unresolved",
  "departure_intent_drift",
  "stale_under_current_policy",
  "budget_exhausted",
]);
export type ExecutionRejectionReason = z.infer<typeof ExecutionRejectionReasonSchema>;

export const ExecutionAdmissibilityDecisionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("admissible"), jobId: CountSchema }),
  z.strictObject({ status: z.literal("rejected"), jobId: CountSchema, reason: ExecutionRejectionReasonSchema }),
]);
export type ExecutionAdmissibilityDecision = z.infer<typeof ExecutionAdmissibilityDecisionSchema>;

export const ExecutionAdmissibilityDiagnosticSchema = z.enum([
  "plan_request_mismatch",
  "departure_dependencies_present",
  "replay_budget_capped",
]);
export type ExecutionAdmissibilityDiagnostic = z.infer<typeof ExecutionAdmissibilityDiagnosticSchema>;

const ExecutionAdmissibilityBaseSchema = z.strictObject({
  kind: z.literal("execution_admissibility"),
  requestId: RouteDiscoveryRequestSchema.shape.requestId,
  trustedContextDigest: z.string(),
  decisions: z.array(ExecutionAdmissibilityDecisionSchema),
  admissibleJobIds: z.array(CountSchema),
  diagnostics: z.array(ExecutionAdmissibilityDiagnosticSchema),
});

export const ExecutionAdmissibilitySchema = ExecutionAdmissibilityBaseSchema.superRefine((result, ctx) => {
  if (!ExecutionAdmissibilityBaseSchema.safeParse(result).success) return;
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });

  // Decision jobIds must be contiguous from 0 in job order.
  result.decisions.forEach((decision, index) => {
    if (decision.jobId !== index) issue("Decision jobIds must be contiguous indexes in job order");
  });

  // admissibleJobIds must be exactly the admissible decisions' ids in order.
  const admissibleFromDecisions = result.decisions
    .filter(d => d.status === "admissible")
    .map(d => d.jobId);
  if (JSON.stringify(result.admissibleJobIds) !== JSON.stringify(admissibleFromDecisions)) {
    issue("admissibleJobIds must be exactly the admissible decisions' ids in order");
  }

  // This schema has neither the plan's jobs nor the execution budget, so it only
  // self-checks jobId contiguity and admissibleJobIds<->decisions consistency above.
  // Two invariants are therefore guaranteed by the ordered checks in
  // validatePlanForExecution, not here: no admissible job carries an
  // after_verified_arrival departure, and admissions stay within budget.
});
export type ExecutionAdmissibility = z.infer<typeof ExecutionAdmissibilitySchema>;

// Mirrors verificationIntentKey: strict-parse then JSON.stringify.
export function trustedContextDigest(ctx: TrustedExecutionContext): string {
  return JSON.stringify(TrustedExecutionContextSchema.parse(ctx));
}

// Canonical JSON comparison (key-order normalized via schema parse).
function canonicalEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validatePlanForExecution(
  rawPlan: VerificationPlan,
  rawContext: TrustedExecutionContext,
): ExecutionAdmissibility {
  // Treat both as untrusted; parse through schemas.
  const plan = VerificationPlanSchema.parse(rawPlan);
  const ctx = TrustedExecutionContextSchema.parse(rawContext);

  const decisions: ExecutionAdmissibilityDecision[] = [];
  const admissibleJobIds: number[] = [];
  const diagnostics: ExecutionAdmissibilityDiagnostic[] = [];

  const ctxAsOf = Date.parse(ctx.asOf);

  // Build a map of eligible candidate decisions for evidence staleness checks.
  const eligibleCandidates = new Map<number, NonNullable<Extract<typeof plan.decisions[number], { status: "eligible" }>["candidate"]>>();
  for (const decision of plan.decisions) {
    if (decision.status === "eligible") {
      eligibleCandidates.set(decision.candidateIndex, decision.candidate);
    }
  }

  let admittedSoFar = 0;
  let budgetDiagnosticAdded = false;
  let mismatchDiagnosticAdded = false;
  let dependenciesDiagnosticAdded = false;

  for (const job of plan.jobs) {
    // Check 1: request_mismatch — plan requestId vs ctx requestId.
    if (plan.requestId !== ctx.requestId) {
      if (!mismatchDiagnosticAdded) {
        diagnostics.push("plan_request_mismatch");
        mismatchDiagnosticAdded = true;
      }
      decisions.push({ status: "rejected", jobId: job.id, reason: "request_mismatch" });
      continue;
    }

    // Check 2: departure_unresolved — after_verified_arrival departure.
    if (job.requestIntent.departure.kind === "after_verified_arrival") {
      if (!dependenciesDiagnosticAdded) {
        diagnostics.push("departure_dependencies_present");
        dependenciesDiagnosticAdded = true;
      }
      decisions.push({ status: "rejected", jobId: job.id, reason: "departure_unresolved" });
      continue;
    }

    // Check 3: departure_intent_drift — departure or passengers mismatch ctx.
    const jobDeparture = job.requestIntent.departure;
    // jobDeparture is request_intent at this point (after_verified_arrival was rejected above).
    const jobDepartureIntent = jobDeparture.kind === "request_intent" ? jobDeparture.intent : null;
    const ctxDeparture = ctx.departure;

    // Normalize both through their schema shapes for key-order canonical comparison.
    const normalizedJobDep = jobDepartureIntent !== null ? JSON.stringify(jobDepartureIntent) : null;
    const normalizedCtxDep = JSON.stringify(ctxDeparture);

    if (normalizedJobDep !== normalizedCtxDep) {
      decisions.push({ status: "rejected", jobId: job.id, reason: "departure_intent_drift" });
      continue;
    }

    // Compare passengers via canonical JSON.
    if (!canonicalEqual(job.requestIntent.passengers, ctx.passengers)) {
      decisions.push({ status: "rejected", jobId: job.id, reason: "departure_intent_drift" });
      continue;
    }

    // Check 4: stale_under_current_policy — recomputed at ctx.asOf under ctx.budget.
    // Mirrors the planner's admissibility rule (contracts.ts): candidate age is
    // rechecked under the ctx policy, and every planned leg must still retain at
    // least one usable bound route-exists fact. Per-leg (not per-index) so a leg
    // backed by several facts stays admissible while any one of them is usable.
    let stale = false;
    for (const binding of job.sourceBindings) {
      const candidate = eligibleCandidates.get(binding.candidateIndex);
      if (!candidate) { stale = true; break; }

      // Candidate age under the ctx policy (future, or older than the ctx age limit).
      const discoveredAt = Date.parse(candidate.discoveredAt);
      if (discoveredAt > ctxAsOf || ctxAsOf - discoveredAt > ctx.budget.maxCandidateAgeMs) { stale = true; break; }

      // Each leg in the bound span needs >= 1 bound evidence index usable at ctxAsOf.
      for (let legIndex = binding.fromLegIndex; legIndex <= binding.toLegIndex; legIndex++) {
        const legStillBacked = binding.routeEvidenceIndices.some(evidenceIndex => {
          const fact = candidate.evidence[evidenceIndex];
          return !!fact && usableRouteEvidence(fact, ctxAsOf) &&
            fact.target.kind === "leg" && fact.target.legIndex === legIndex;
        });
        if (!legStillBacked) { stale = true; break; }
      }
      if (stale) break;
    }

    if (stale) {
      decisions.push({ status: "rejected", jobId: job.id, reason: "stale_under_current_policy" });
      continue;
    }

    // Check 5: budget_exhausted — charge budget deterministically.
    if (ctx.budget.alreadyConsumedIntents + admittedSoFar >= ctx.budget.maxProviderIntents) {
      if (!budgetDiagnosticAdded) {
        diagnostics.push("replay_budget_capped");
        budgetDiagnosticAdded = true;
      }
      decisions.push({ status: "rejected", jobId: job.id, reason: "budget_exhausted" });
      continue;
    }

    // Admissible.
    decisions.push({ status: "admissible", jobId: job.id });
    admissibleJobIds.push(job.id);
    admittedSoFar++;
  }

  const result: ExecutionAdmissibility = {
    kind: "execution_admissibility",
    requestId: ctx.requestId,
    trustedContextDigest: trustedContextDigest(ctx),
    decisions,
    admissibleJobIds,
    diagnostics,
  };

  return ExecutionAdmissibilitySchema.parse(result);
}
