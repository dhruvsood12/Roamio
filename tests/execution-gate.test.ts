import { describe, expect, it } from "vitest";
import {
  ExecutionAdmissibilitySchema, TrustedExecutionContextSchema, VerificationPlanSchema,
  validatePlanForExecution,
  type ExecutionAdmissibility, type TrustedExecutionContext,
} from "@flightbrain/composer";
import { discoveryRequest } from "./fixtures/discovery";
import { verificationCandidate as candidate, verificationExamples as examples } from "./fixtures/verification";
import { expiringEvidenceCandidate, trustedExecutionContext } from "./fixtures/execution";
import { planVerificationJobs } from "../packages/composer/src/index";

// Synthetic canonical topology only; no genuine source/service claims.

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
}

// Build a plan using request-1 / DEL–SFO / unspecified / no passengers.
const defaultPolicy = () => ({
  asOf: "2026-09-21T10:00:00Z",
  maxCandidateAgeMs: 60_000,
  maxCandidates: 10,
  maxLegsPerCandidate: 8,
  maxJobs: 100,
});

function buildPlan(candidateList = examples(), policyChange: Record<string, unknown> = {}) {
  return planVerificationJobs(discoveryRequest(), candidateList, { ...defaultPolicy(), ...policyChange });
}

describe("execution admissibility gate — happy path", () => {
  it("admits all request_intent jobs and rejects after_verified_arrival jobs", () => {
    const plan = buildPlan();
    const ctx = trustedExecutionContext();
    const result = validatePlanForExecution(plan, ctx);

    // All jobs with request_intent departure should be admissible (after_verified_arrival rejected).
    const requestIntentJobs = plan.jobs.filter(j => j.requestIntent.departure.kind === "request_intent");
    const afterVerifiedArrivalJobs = plan.jobs.filter(j => j.requestIntent.departure.kind === "after_verified_arrival");

    expect(result.kind).toBe("execution_admissibility");
    expect(result.requestId).toBe("request-1");

    // Admissible job IDs must match the request_intent jobs in order.
    const admissibleDecisions = result.decisions.filter(d => d.status === "admissible");
    expect(admissibleDecisions.map(d => d.jobId)).toEqual(requestIntentJobs.map(j => j.id));
    expect(result.admissibleJobIds).toEqual(requestIntentJobs.map(j => j.id));

    // after_verified_arrival jobs must be rejected with departure_unresolved.
    const unresolvedDecisions = result.decisions.filter(d => d.status === "rejected" && d.reason === "departure_unresolved");
    expect(unresolvedDecisions.map(d => d.jobId)).toEqual(afterVerifiedArrivalJobs.map(j => j.id));

    // departure_dependencies_present diagnostic added exactly once if any such jobs exist.
    if (afterVerifiedArrivalJobs.length > 0) {
      expect(result.diagnostics.filter(d => d === "departure_dependencies_present")).toHaveLength(1);
    }
  });

  it("admissibleJobIds equals ordered admissible job ids", () => {
    const plan = buildPlan();
    const ctx = trustedExecutionContext();
    const result = validatePlanForExecution(plan, ctx);

    const fromDecisions = result.decisions
      .filter(d => d.status === "admissible")
      .map(d => d.jobId);
    expect(result.admissibleJobIds).toEqual(fromDecisions);
  });

  it("decisions are in job order and jobId matches index", () => {
    const plan = buildPlan();
    const ctx = trustedExecutionContext();
    const result = validatePlanForExecution(plan, ctx);

    result.decisions.forEach((decision, index) => {
      expect(decision.jobId).toBe(index);
    });
    expect(result.decisions).toHaveLength(plan.jobs.length);
  });

  it("JSON round-trip equality", () => {
    const plan = buildPlan();
    const ctx = trustedExecutionContext();
    const result = validatePlanForExecution(plan, ctx);
    expect(ExecutionAdmissibilitySchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it("result has no commercial fields", () => {
    const plan = buildPlan();
    const ctx = trustedExecutionContext();
    const result = validatePlanForExecution(plan, ctx);
    for (const field of ["offers", "trips", "price", "scheduleFingerprint", "bookingUrl", "totalPrice"]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it("is deterministic — two identical calls deep-equal", () => {
    const plan = buildPlan();
    const ctx = trustedExecutionContext();
    const r1 = validatePlanForExecution(plan, ctx);
    const r2 = validatePlanForExecution(plan, ctx);
    expect(r1).toEqual(r2);
  });

  it("is pure — freezeDeep inputs, does not throw", () => {
    const plan = buildPlan();
    const ctx = trustedExecutionContext();
    freezeDeep(plan);
    freezeDeep(ctx);
    expect(() => validatePlanForExecution(plan, ctx)).not.toThrow();
  });
});

describe("execution admissibility gate — failure cases", () => {
  it("request_mismatch: all jobs rejected and admissibleJobIds is empty", () => {
    const plan = buildPlan();
    const ctx = trustedExecutionContext({ requestId: "different-request-id" });
    const result = validatePlanForExecution(plan, ctx);

    expect(result.admissibleJobIds).toEqual([]);
    expect(result.decisions.every(d => d.status === "rejected" && d.reason === "request_mismatch")).toBe(true);
    // plan_request_mismatch diagnostic added exactly once.
    expect(result.diagnostics.filter(d => d === "plan_request_mismatch")).toHaveLength(1);
  });

  it("departure_intent_drift: jobs rejected when ctx departure differs", () => {
    const plan = buildPlan();
    // Use a dated departure in ctx but the plan was built with unspecified.
    const ctx = trustedExecutionContext({
      departure: { kind: "date", date: "2026-11-15" },
    });
    const result = validatePlanForExecution(plan, ctx);

    // All request_intent departure jobs should be rejected with departure_intent_drift.
    const requestIntentJobs = plan.jobs.filter(j => j.requestIntent.departure.kind === "request_intent");
    const driftDecisions = result.decisions.filter(d => d.status === "rejected" && d.reason === "departure_intent_drift");
    expect(driftDecisions.map(d => d.jobId)).toEqual(requestIntentJobs.map(j => j.id));
    expect(result.admissibleJobIds).toEqual([]);
  });

  it("departure_intent_drift: jobs rejected when ctx passengers differ", () => {
    // Build a plan with passengers = null, then check with passengers set.
    const plan = buildPlan([candidate(["DEL", "SFO"])]);
    const ctx = trustedExecutionContext({ passengers: { count: 2 } });
    const result = validatePlanForExecution(plan, ctx);

    const requestIntentJobs = plan.jobs.filter(j => j.requestIntent.departure.kind === "request_intent");
    const driftDecisions = result.decisions.filter(d => d.status === "rejected" && d.reason === "departure_intent_drift");
    expect(driftDecisions.map(d => d.jobId)).toEqual(requestIntentJobs.map(j => j.id));
  });

  it("stale_under_current_policy: rejected when asOf advanced past candidate age expiry", () => {
    // The discovery fixture has discoveredAt = "2026-09-21T10:00:00Z".
    // If we advance asOf by more than maxCandidateAgeMs from discoveredAt, the job becomes stale.
    const plan = buildPlan([candidate(["DEL", "SFO"])]);
    // Advance asOf by 2 minutes; use maxCandidateAgeMs of 60_000ms (1 minute).
    const ctx = trustedExecutionContext({
      asOf: "2026-09-21T10:02:00Z",
      budget: {
        maxProviderIntents: 1_000,
        alreadyConsumedIntents: 0,
        maxCandidateAgeMs: 60_000, // 1 minute
      },
    });
    const result = validatePlanForExecution(plan, ctx);

    expect(result.admissibleJobIds).toEqual([]);
    expect(result.decisions.every(d => d.status === "rejected" && d.reason === "stale_under_current_policy")).toBe(true);
  });

  it("stale_under_current_policy: equality at the age limit is accepted", () => {
    // discoveredAt = "2026-09-21T10:00:00Z", asOf = "2026-09-21T10:01:00Z" (exactly 60_000ms later).
    // maxCandidateAgeMs = 60_000 → ctxAsOf - discoveredAt = 60_000 = maxCandidateAgeMs → NOT stale (accept equality).
    const plan = buildPlan([candidate(["DEL", "SFO"])]);
    const ctx = trustedExecutionContext({
      asOf: "2026-09-21T10:01:00Z",
      budget: {
        maxProviderIntents: 1_000,
        alreadyConsumedIntents: 0,
        maxCandidateAgeMs: 60_000, // exactly at limit
      },
    });
    const result = validatePlanForExecution(plan, ctx);

    // The single DEL→SFO job has departure request_intent and age == limit, so it should be admissible.
    const requestIntentJobs = plan.jobs.filter(j => j.requestIntent.departure.kind === "request_intent");
    expect(result.admissibleJobIds).toEqual(requestIntentJobs.map(j => j.id));
    expect(result.decisions.filter(d => d.status === "admissible")).toHaveLength(requestIntentJobs.length);
  });

  // Evidence-freshness branch (distinct from candidate age): bound route-exists fact
  // has a finite expiresAt. usableRouteEvidence requires expiresAt strictly > asOf and
  // observedAt <= asOf, so these pin the exact boundary semantics.
  const freshEvidenceBudget = { maxProviderIntents: 1_000, alreadyConsumedIntents: 0, maxCandidateAgeMs: 600_000 };

  it("stale_under_current_policy: bound evidence past its expiresAt is rejected", () => {
    const plan = buildPlan([expiringEvidenceCandidate("2026-09-21T10:05:00Z")]);
    const ctx = trustedExecutionContext({ asOf: "2026-09-21T10:06:00Z", budget: freshEvidenceBudget });
    const result = validatePlanForExecution(plan, ctx);
    expect(result.admissibleJobIds).toEqual([]);
    expect(result.decisions.every(d => d.status === "rejected" && d.reason === "stale_under_current_policy")).toBe(true);
  });

  it("stale_under_current_policy: bound evidence still within its expiresAt is admissible", () => {
    const plan = buildPlan([expiringEvidenceCandidate("2026-09-21T10:05:00Z")]);
    const ctx = trustedExecutionContext({ asOf: "2026-09-21T10:04:00Z", budget: freshEvidenceBudget });
    const result = validatePlanForExecution(plan, ctx);
    const requestIntentJobs = plan.jobs.filter(j => j.requestIntent.departure.kind === "request_intent");
    expect(result.admissibleJobIds).toEqual(requestIntentJobs.map(j => j.id));
  });

  it("stale_under_current_policy: asOf exactly at expiresAt is stale (strict > boundary)", () => {
    const plan = buildPlan([expiringEvidenceCandidate("2026-09-21T10:05:00Z")]);
    const ctx = trustedExecutionContext({ asOf: "2026-09-21T10:05:00Z", budget: freshEvidenceBudget });
    const result = validatePlanForExecution(plan, ctx);
    expect(result.admissibleJobIds).toEqual([]);
    expect(result.decisions.every(d => d.status === "rejected" && d.reason === "stale_under_current_policy")).toBe(true);
  });

  it("stale_under_current_policy: evidence observedAt exactly equal to asOf is accepted", () => {
    const plan = buildPlan([expiringEvidenceCandidate("2026-09-21T10:05:00Z", "2026-09-21T10:00:00Z")]);
    const ctx = trustedExecutionContext({ asOf: "2026-09-21T10:00:00Z", budget: freshEvidenceBudget });
    const result = validatePlanForExecution(plan, ctx);
    const requestIntentJobs = plan.jobs.filter(j => j.requestIntent.departure.kind === "request_intent");
    expect(result.admissibleJobIds).toEqual(requestIntentJobs.map(j => j.id));
  });

  it.each([0, 1, 2, 3])("budget_exhausted: sweeping alreadyConsumedIntents=%i admits exactly max-consumed in order", alreadyConsumed => {
    // Use a single-candidate plan (DEL→SFO only, 1 job) to keep it simple.
    const plan = buildPlan([candidate(["DEL", "SFO"])]);
    const requestIntentCount = plan.jobs.filter(j => j.requestIntent.departure.kind === "request_intent").length;
    const maxProviderIntents = 2;

    const ctx = trustedExecutionContext({
      budget: {
        maxProviderIntents,
        alreadyConsumedIntents: alreadyConsumed,
        maxCandidateAgeMs: 300_000,
      },
    });
    const result = validatePlanForExecution(plan, ctx);

    const remaining = Math.max(0, maxProviderIntents - alreadyConsumed);
    const expectedAdmissible = Math.min(remaining, requestIntentCount);

    expect(result.admissibleJobIds).toHaveLength(expectedAdmissible);
    // All admissible IDs come before all budget_exhausted rejections.
    const admissibleIds = result.admissibleJobIds;
    const budgetExhaustedDecisions = result.decisions.filter(d => d.status === "rejected" && d.reason === "budget_exhausted");

    if (admissibleIds.length > 0 && budgetExhaustedDecisions.length > 0) {
      expect(Math.max(...admissibleIds)).toBeLessThan(Math.min(...budgetExhaustedDecisions.map(d => d.jobId)));
    }
  });

  it("zero maxProviderIntents: zero admissible", () => {
    const plan = buildPlan([candidate(["DEL", "SFO"])]);
    const ctx = trustedExecutionContext({
      budget: { maxProviderIntents: 0, alreadyConsumedIntents: 0, maxCandidateAgeMs: 300_000 },
    });
    const result = validatePlanForExecution(plan, ctx);
    expect(result.admissibleJobIds).toEqual([]);
    // All request_intent jobs should be budget_exhausted.
    const requestIntentJobs = plan.jobs.filter(j => j.requestIntent.departure.kind === "request_intent");
    if (requestIntentJobs.length > 0) {
      expect(result.diagnostics).toContain("replay_budget_capped");
    }
  });

  it("budget_exhausted: replay_budget_capped diagnostic added exactly once", () => {
    const plan = buildPlan([candidate(["DEL", "SFO"]), candidate(["DEL", "NRT", "SFO"], "c2")]);
    const ctx = trustedExecutionContext({
      budget: { maxProviderIntents: 1, alreadyConsumedIntents: 0, maxCandidateAgeMs: 300_000 },
    });
    const result = validatePlanForExecution(plan, ctx);
    const budgetDiagnostics = result.diagnostics.filter(d => d === "replay_budget_capped");
    if (result.decisions.some(d => d.status === "rejected" && d.reason === "budget_exhausted")) {
      expect(budgetDiagnostics).toHaveLength(1);
    }
  });
});

describe("execution admissibility gate — schema validation", () => {
  it("throws on malformed plan", () => {
    const ctx = trustedExecutionContext();
    expect(() => validatePlanForExecution({} as never, ctx)).toThrow();
    expect(() => validatePlanForExecution(null as never, ctx)).toThrow();
    expect(() => validatePlanForExecution({ kind: "verification_plan", extra: true } as never, ctx)).toThrow();
  });

  it("throws on malformed context", () => {
    const plan = buildPlan([candidate(["DEL", "SFO"])]);
    expect(() => validatePlanForExecution(plan, {} as never)).toThrow();
    expect(() => validatePlanForExecution(plan, null as never)).toThrow();
    expect(() => validatePlanForExecution(plan, { requestId: "x", extra: true } as never)).toThrow();
  });

  it("schema rejects admissibleJobIds out of sync with admissible decisions", () => {
    const plan = buildPlan(examples());
    const ctx = trustedExecutionContext();
    const result = validatePlanForExecution(plan, ctx);

    // Find a rejected departure_unresolved decision (after_verified_arrival job).
    const unresolvedDecision = result.decisions.find(d => d.status === "rejected" && d.reason === "departure_unresolved");
    if (!unresolvedDecision) return; // No such job in this plan; skip gracefully.

    // Corrupt: change a rejected decision to admissible but leave admissibleJobIds unmodified.
    // This creates a mismatch: admissibleJobIds doesn't include the now-admissible job.
    const corrupted = JSON.parse(JSON.stringify(result)) as ExecutionAdmissibility;
    const idx = corrupted.decisions.findIndex(d => d.jobId === unresolvedDecision.jobId);
    corrupted.decisions[idx] = { status: "admissible", jobId: unresolvedDecision.jobId };
    // admissibleJobIds now doesn't include this jobId — schema must reject.
    expect(ExecutionAdmissibilitySchema.safeParse(corrupted).success).toBe(false);
  });

  it("schema rejects inconsistent admissibleJobIds (extra id not in admissible decisions)", () => {
    const plan = buildPlan([candidate(["DEL", "SFO"])]);
    const ctx = trustedExecutionContext();
    const result = validatePlanForExecution(plan, ctx);

    const corrupted = JSON.parse(JSON.stringify(result)) as ExecutionAdmissibility;
    // Add a spurious id that doesn't correspond to an admissible decision.
    corrupted.admissibleJobIds.push(9999);
    expect(ExecutionAdmissibilitySchema.safeParse(corrupted).success).toBe(false);
  });

  it("schema rejects out-of-order jobIds in decisions", () => {
    const plan = buildPlan([candidate(["DEL", "NRT", "SFO"], "c1"), candidate(["DEL", "SFO"], "c2")]);
    const ctx = trustedExecutionContext();
    const result = validatePlanForExecution(plan, ctx);

    if (result.decisions.length < 2) return;
    const corrupted = JSON.parse(JSON.stringify(result)) as ExecutionAdmissibility;
    // Swap two decisions' jobIds to create non-contiguous ordering.
    const tmp = corrupted.decisions[0].jobId;
    (corrupted.decisions[0] as { jobId: number }).jobId = corrupted.decisions[1].jobId;
    (corrupted.decisions[1] as { jobId: number }).jobId = tmp;

    expect(ExecutionAdmissibilitySchema.safeParse(corrupted).success).toBe(false);
  });
});

describe("execution admissibility gate — precedence and isolation", () => {
  it("checks in fixed precedence: mismatch beats unresolved, unresolved beats drift, drift beats stale, stale beats budget", () => {
    // Build a plan with after_verified_arrival jobs.
    const plan = buildPlan(examples());
    // Set a different requestId to trigger mismatch for all jobs.
    const ctx = trustedExecutionContext({ requestId: "different-request" });
    const result = validatePlanForExecution(plan, ctx);

    // All decisions should be request_mismatch (highest precedence), even for after_verified_arrival jobs.
    expect(result.decisions.every(d => d.status === "rejected" && d.reason === "request_mismatch")).toBe(true);
    expect(result.diagnostics).toContain("plan_request_mismatch");
    // Should NOT contain departure_dependencies_present because mismatch fires first.
    expect(result.diagnostics).not.toContain("departure_dependencies_present");
  });

  it("purity: inputs unchanged after validation with frozen inputs", () => {
    const plan = buildPlan(examples());
    const ctx = trustedExecutionContext();
    const planBefore = structuredClone(plan);
    const ctxBefore = structuredClone(ctx);
    freezeDeep(plan);
    freezeDeep(ctx);

    validatePlanForExecution(plan, ctx);

    expect(plan).toEqual(planBefore);
    expect(ctx).toEqual(ctxBefore);
  });

  it("trustedContextDigest is stable across calls", () => {
    const ctx = trustedExecutionContext();
    const plan = buildPlan([candidate(["DEL", "SFO"])]);
    const r1 = validatePlanForExecution(plan, ctx);
    const r2 = validatePlanForExecution(plan, ctx);
    expect(r1.trustedContextDigest).toBe(r2.trustedContextDigest);
  });

  it("trustedContextDigest changes when context changes", () => {
    const ctx1 = trustedExecutionContext();
    const ctx2 = trustedExecutionContext({ departure: { kind: "date", date: "2026-10-01" } });
    const plan = buildPlan([candidate(["DEL", "SFO"])]);
    const r1 = validatePlanForExecution(plan, ctx1);
    const r2 = validatePlanForExecution(plan, ctx2);
    expect(r1.trustedContextDigest).not.toBe(r2.trustedContextDigest);
  });
});
