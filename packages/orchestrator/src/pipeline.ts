/**
 * C004 pipeline.ts — deterministic E0→E1→intake→E2→E5→E6→C003 orchestration.
 *
 * Drives one request through:
 *   E0 (validatePlanForExecution) → admissible job IDs
 *   E1 (resolveCommercialRequests) → resolved descriptors
 *   port.intake (injected, default = E4 mock) → FlightOffers per job
 *   computeOfferFingerprints → edge fingerprinting (once per job)
 *   toFeasibilityInput → E2 (evaluateConnectionFeasibility)
 *   toProtectionInput + assessItineraryProtection → E5
 *   toTripCompositionRequests → E6 (composeTripOptions)
 *   rankTripOptions → C003 ranking
 *   recordAttempt → ledger threading (idempotent by content key)
 *
 * CONTRACT:
 * - No wall clock (inject asOf via policy).
 * - No real network (inject port; default = mockProviderIntakePort).
 * - Budget exhaustion fails closed: zero intake calls for rejected jobs.
 * - Ledger replay idempotent: feeding ledgerAfter back → same ranking, no double-charge.
 */

import { z } from "zod";
import {
  MockIntakePolicySchema,
  SyntheticProvenanceSchema,
  assessItineraryProtection,
  composeTripOptions,
  nextBudget,
  recordAttempt,
  resolveCommercialRequests,
  trustedContextDigest,
  validatePlanForExecution,
  type CommercialResolution,
  type ExecutionAdmissibility,
  type ExecutionAttemptRecord,
  type ExecutionLedger,
  type MockIntakeOutcome,
  type TripCompositionResult,
  type TrustedExecutionContext,
  type VerificationPlan,
  type VerificationRequestIntent,
  VerificationRequestIntentSchema,
} from "@flightbrain/composer";
import { FlightOfferSchema, type FlightOffer } from "@flightbrain/domain";
import { rankTripOptions, type TripRankingResult } from "@flightbrain/ranking";
import {
  mockProviderIntakePort,
  type ProviderIntakePort,
} from "./intake-port";
import {
  computeOfferFingerprints,
  toFeasibilityInput,
  toProtectionInput,
  toTripCompositionRequests,
  OrchestrationPolicySchema,
  type OfferedJob,
  type OrchestrationPolicy,
} from "./marshal";

// ---------------------------------------------------------------------------
// OrchestrationDiagnostic enum
// Unifies upstream diagnostics + pipeline-level diagnostics.
// ---------------------------------------------------------------------------

export const OrchestrationDiagnosticSchema = z.enum([
  // From E0 (validatePlanForExecution)
  "plan_request_mismatch",
  "departure_dependencies_present",
  "replay_budget_capped",
  // From E1 (resolveCommercialRequests)
  "unresolved_departures_present",
  "invalid_endpoints_present",
  "request_mismatch",
  "context_mismatch",
  // Pipeline-level
  "intake_declined",
  "budget_exhausted",
  "fingerprint_conflict",
  "no_admissible_jobs",
]);
export type OrchestrationDiagnostic = z.infer<typeof OrchestrationDiagnosticSchema>;

// ---------------------------------------------------------------------------
// OrchestrationInput / OrchestrationResult
// ---------------------------------------------------------------------------

export type OrchestrationInput = {
  plan: VerificationPlan;
  context: TrustedExecutionContext;
  ledger: ExecutionLedger;
  policy: OrchestrationPolicy;
};

export type OrchestrationResult = {
  admissibility: ExecutionAdmissibility;
  resolution: CommercialResolution;
  intake: MockIntakeOutcome[];
  fingerprints: Array<{ jobId: number; fingerprint: string | null }>;
  composition: TripCompositionResult;
  ranking: TripRankingResult;
  ledgerAfter: ExecutionLedger;
  diagnostics: OrchestrationDiagnostic[];
};

// Re-export for convenience
export { OrchestrationPolicySchema, type OrchestrationPolicy };

// ---------------------------------------------------------------------------
// Default port factory (used when no port is injected)
// ---------------------------------------------------------------------------

function defaultPort(policy: OrchestrationPolicy): ProviderIntakePort {
  const mockPolicy = MockIntakePolicySchema.parse(policy.mockIntakePolicy);
  const mockProvenance = SyntheticProvenanceSchema.parse(policy.mockProvenance);
  return mockProviderIntakePort(mockPolicy, mockProvenance);
}

// ---------------------------------------------------------------------------
// runProviderOrchestration — the main pipeline function
// ---------------------------------------------------------------------------

/**
 * Drives one request through the full E0→E6→C003 pipeline.
 *
 * @param input - OrchestrationInput (plan, context, ledger, policy)
 * @param port - injected ProviderIntakePort (default = E4 mock)
 * @returns OrchestrationResult with ranked TripOptions and diagnostics
 */
export async function runProviderOrchestration(
  input: OrchestrationInput,
  port?: ProviderIntakePort,
): Promise<OrchestrationResult> {
  const { plan, context: rawContext, ledger, policy } = input;

  // Resolve the intake port (default = mock).
  const intakePort = port ?? defaultPort(policy);

  // -----------------------------------------------------------------------
  // Step 1: nextBudget → spread into context.budget
  // -----------------------------------------------------------------------
  const budget = nextBudget(ledger, policy.ledgerBudget);

  // Build the effective trusted execution context with the computed budget.
  const context: TrustedExecutionContext = {
    ...rawContext,
    budget,
  };

  // -----------------------------------------------------------------------
  // Step 2: E0 — validatePlanForExecution
  // -----------------------------------------------------------------------
  const admissibility = validatePlanForExecution(plan, context);

  const diagnostics: OrchestrationDiagnostic[] = [];

  // Surface E0 diagnostics — push any that are part of the orchestration vocabulary
  // (schema-filtered rather than a hand-maintained identity map that could drift).
  for (const d of admissibility.diagnostics) {
    const parsed = OrchestrationDiagnosticSchema.safeParse(d);
    if (parsed.success) diagnostics.push(parsed.data);
  }

  if (admissibility.admissibleJobIds.length === 0) {
    diagnostics.push("no_admissible_jobs");
    // Build empty resolution + composition + ranking.
    const emptyResolution: CommercialResolution = {
      kind: "commercial_resolution",
      requestId: context.requestId,
      decisions: [],
      resolvedJobIds: [],
      diagnostics: [],
    };
    const emptyComposition = composeTripOptions(context.requestId, []);
    const emptyRanking = rankTripOptions([], policy.rankingPolicy);
    return {
      admissibility,
      resolution: emptyResolution,
      intake: [],
      fingerprints: [],
      composition: emptyComposition,
      ranking: emptyRanking,
      ledgerAfter: ledger,
      diagnostics,
    };
  }

  // -----------------------------------------------------------------------
  // Step 3: E1 — resolveCommercialRequests
  // -----------------------------------------------------------------------
  const resolution = resolveCommercialRequests(plan, admissibility, context);

  // Surface E1 diagnostics (schema-filtered, same rationale as the E0 loop above).
  for (const d of resolution.diagnostics) {
    const parsed = OrchestrationDiagnosticSchema.safeParse(d);
    if (parsed.success) diagnostics.push(parsed.data);
  }

  // -----------------------------------------------------------------------
  // Step 4: per-descriptor intake via port (in plan job order)
  // Budget exhaustion is enforced by E0 — all resolved descriptors are already
  // within budget. We call intake only for resolved descriptors.
  // -----------------------------------------------------------------------

  const intakeContext = { asOf: policy.asOf };
  const intakeOutcomes: MockIntakeOutcome[] = [];
  const offeredJobs: OfferedJob[] = [];
  const fingerprintMap: Array<{ jobId: number; fingerprint: string | null }> = [];
  let hasIntakeDeclined = false;

  for (const decision of resolution.decisions) {
    if (decision.outcome !== "resolved") continue;

    const descriptor = decision.descriptor;
    const jobId = descriptor.jobId;

    // Call the injected port (throws RealProviderNotImplementedError for deferred real port).
    const outcome = await intakePort.intake(descriptor, intakeContext);
    intakeOutcomes.push(outcome);

    if (outcome.outcome !== "offered") {
      hasIntakeDeclined = true;
      continue;
    }

    // -----------------------------------------------------------------------
    // Step 5: computeOfferFingerprints (edge, exactly once per offer)
    // -----------------------------------------------------------------------
    const parsedOffers: FlightOffer[] = outcome.offers.map((o) =>
      FlightOfferSchema.parse(o),
    );

    const withFingerprints = computeOfferFingerprints(parsedOffers);

    for (const { offer, fingerprint } of withFingerprints) {
      fingerprintMap.push({ jobId, fingerprint });

      // -------------------------------------------------------------------
      // Step 6: E2 feasibility + E5 protection per offer
      // -------------------------------------------------------------------
      const feasibility = toFeasibilityInput(offer, policy.connectionPolicy, jobId);
      const protectionInput = toProtectionInput(offer, fingerprint, jobId);
      const protectionResult = assessItineraryProtection(protectionInput);

      const composedProtection = {
        protectionFacts: protectionResult.protectionFacts,
        scheduleFingerprint: protectionResult.scheduleFingerprint,
      };

      offeredJobs.push({
        jobId,
        offer,
        fingerprint,
        feasibility,
        protection: composedProtection,
      });
    }
  }

  if (hasIntakeDeclined) {
    diagnostics.push("intake_declined");
  }

  // -----------------------------------------------------------------------
  // Step 7: E6 — composeTripOptions
  // Preserves plan job order: offeredJobs are already in resolution order
  // which follows plan.jobs order (E1 iterates admissibleJobIds in order).
  // -----------------------------------------------------------------------
  const compositionRequests = toTripCompositionRequests(offeredJobs, context.requestId);
  const composition = composeTripOptions(context.requestId, compositionRequests);

  // -----------------------------------------------------------------------
  // Step 8: C003 — rankTripOptions
  // -----------------------------------------------------------------------
  const composedTrips = composition.outcomes
    .filter((o) => o.outcome === "composed")
    .map((o) => (o as Extract<typeof o, { outcome: "composed" }>).trip);

  const ranking = rankTripOptions(composedTrips, policy.rankingPolicy);

  // -----------------------------------------------------------------------
  // Step 9: recordAttempt — thread the ledger
  // Build an attempt record from consumed intents (resolved descriptors).
  // Idempotent by content key: same intents → same key → no double-charge.
  // -----------------------------------------------------------------------

  // Collect the attempted intents from the plan jobs that were admitted+resolved.
  const attemptedIntents: VerificationRequestIntent[] = [];
  const seenIntentKeys = new Set<string>();

  // Inline intent key: matches verificationIntentKey from contracts.ts.
  const intentKey = (intent: VerificationRequestIntent): string =>
    JSON.stringify(VerificationRequestIntentSchema.parse(intent));

  for (const decision of resolution.decisions) {
    if (decision.outcome !== "resolved") continue;
    const descriptor = decision.descriptor;
    const job = plan.jobs.find((j) => j.id === descriptor.jobId);
    if (!job) continue;
    const key = intentKey(job.requestIntent);
    if (!seenIntentKeys.has(key)) {
      seenIntentKeys.add(key);
      attemptedIntents.push(job.requestIntent);
    }
  }

  let ledgerAfter = ledger;
  if (attemptedIntents.length > 0) {
    const attemptRecord: ExecutionAttemptRecord = {
      requestId: context.requestId,
      trustedContextDigest: trustedContextDigest(context),
      attemptedIntents,
      consumedIntentCount: attemptedIntents.length,
    };

    try {
      ledgerAfter = recordAttempt(ledger, attemptRecord);
    } catch {
      // If recordAttempt throws (e.g. requestId mismatch), keep original ledger.
    }
  }

  return {
    admissibility,
    resolution,
    intake: intakeOutcomes,
    fingerprints: fingerprintMap,
    composition,
    ranking,
    ledgerAfter,
    diagnostics,
  };
}
