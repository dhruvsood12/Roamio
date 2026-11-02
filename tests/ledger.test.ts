import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
  ExecutionAttemptRecordSchema, ExecutionLedgerSchema,
  LedgerBudgetPolicySchema,
  attemptKey, consumedIntents, emptyLedger, nextBudget, recordAttempt,
  validatePlanForExecution,
  type ExecutionAttemptRecord, type ExecutionLedger,
} from "@flightbrain/composer";
import { discoveryRequest } from "./fixtures/discovery";
import { executionAttemptRecord, executionLedger, trustedExecutionContext } from "./fixtures/execution";
import { verificationCandidate } from "./fixtures/verification";
import { planVerificationJobs } from "../packages/composer/src/index";

// Synthetic canonical topology only; no genuine source/service claims.

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.values(value as object).forEach(freezeDeep);
    Object.freeze(value);
  }
}

const defaultPolicy = () => ({
  asOf: "2026-09-21T10:00:00Z",
  maxCandidateAgeMs: 300_000,
  maxCandidates: 10,
  maxLegsPerCandidate: 8,
  maxJobs: 100,
});

// ---------------------------------------------------------------------------
// 1. empty ledger
// ---------------------------------------------------------------------------

describe("E3 ledger — empty ledger", () => {
  it("consumedIntents returns 0 for empty ledger", () => {
    const ledger = emptyLedger("request-1");
    expect(consumedIntents(ledger)).toBe(0);
  });

  it("nextBudget.alreadyConsumedIntents is 0 for empty ledger", () => {
    const ledger = emptyLedger("request-1");
    const policy = LedgerBudgetPolicySchema.parse({ maxProviderIntents: 500, maxCandidateAgeMs: 300_000 });
    const budget = nextBudget(ledger, policy);
    expect(budget.alreadyConsumedIntents).toBe(0);
    expect(budget.maxProviderIntents).toBe(500);
    expect(budget.maxCandidateAgeMs).toBe(300_000);
  });

  it("empty records [] parses", () => {
    expect(ExecutionLedgerSchema.safeParse({ kind: "execution_ledger", requestId: "request-1", records: [] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. one record of N distinct intents -> N
// ---------------------------------------------------------------------------

describe("E3 ledger — one record", () => {
  it("consumedIntents equals N for one record with N distinct intents", () => {
    const req = discoveryRequest();
    const intent1 = { airports: ["DEL", "SFO"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers };
    const intent2 = { airports: ["DEL", "NRT"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers };
    const record = ExecutionAttemptRecordSchema.parse({
      requestId: req.requestId,
      trustedContextDigest: "digest-abc",
      attemptedIntents: [intent1, intent2],
      consumedIntentCount: 2,
    });
    const ledger = ExecutionLedgerSchema.parse({ kind: "execution_ledger", requestId: req.requestId, records: [record] });
    expect(consumedIntents(ledger)).toBe(2);
  });

  it("nextBudget policy caps copied verbatim", () => {
    const ledger = executionLedger();
    const policy = LedgerBudgetPolicySchema.parse({ maxProviderIntents: 777, maxCandidateAgeMs: 99_999 });
    const budget = nextBudget(ledger, policy);
    expect(budget.maxProviderIntents).toBe(777);
    expect(budget.maxCandidateAgeMs).toBe(99_999);
    expect(budget.alreadyConsumedIntents).toBe(consumedIntents(ledger));
  });
});

// ---------------------------------------------------------------------------
// 3. nextBudget fed into validatePlanForExecution reproduces E0 budget behavior
// ---------------------------------------------------------------------------

describe("E3 ledger — integration with validatePlanForExecution (E0)", () => {
  it("nextBudget output reproduces E0 budget behavior (happy path)", () => {
    const req = discoveryRequest();
    const ledger = emptyLedger(req.requestId);
    const policy = LedgerBudgetPolicySchema.parse({ maxProviderIntents: 1_000, maxCandidateAgeMs: 300_000 });
    const budget = nextBudget(ledger, policy);

    const ctx = trustedExecutionContext({ budget });
    const plan = planVerificationJobs(req, [verificationCandidate(["DEL", "SFO"])], defaultPolicy());
    const result = validatePlanForExecution(plan, ctx);

    expect(result.kind).toBe("execution_admissibility");
    expect(result.admissibleJobIds.length).toBeGreaterThan(0);
  });

  it("nextBudget with 0 maxProviderIntents causes all jobs budget_exhausted", () => {
    const req = discoveryRequest();
    const ledger = emptyLedger(req.requestId);
    const policy = LedgerBudgetPolicySchema.parse({ maxProviderIntents: 0, maxCandidateAgeMs: 300_000 });
    const budget = nextBudget(ledger, policy);

    const ctx = trustedExecutionContext({ budget });
    const plan = planVerificationJobs(req, [verificationCandidate(["DEL", "SFO"])], defaultPolicy());
    const result = validatePlanForExecution(plan, ctx);

    expect(result.admissibleJobIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. structural duplicate attemptKey FAILS ExecutionLedgerSchema.parse
// ---------------------------------------------------------------------------

describe("E3 ledger — duplicate rejection", () => {
  it("structural duplicate attemptKey FAILS ExecutionLedgerSchema.parse", () => {
    const record = executionAttemptRecord();
    const result = ExecutionLedgerSchema.safeParse({
      kind: "execution_ledger",
      requestId: record.requestId,
      records: [record, record],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. recordAttempt of an existing record is idempotent
// ---------------------------------------------------------------------------

describe("E3 ledger — recordAttempt idempotency", () => {
  it("recordAttempt of an existing record leaves records.length & consumedIntents unchanged", () => {
    const record = executionAttemptRecord();
    const ledger = ExecutionLedgerSchema.parse({
      kind: "execution_ledger",
      requestId: record.requestId,
      records: [record],
    });

    const before = consumedIntents(ledger);
    const beforeLen = ledger.records.length;

    const result = recordAttempt(ledger, record);

    expect(result.records.length).toBe(beforeLen);
    expect(consumedIntents(result)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 6. cross-attempt UNION dedup — two distinct records sharing intents count shared ones once
// ---------------------------------------------------------------------------

describe("E3 ledger — cross-attempt UNION dedup", () => {
  it("two distinct records sharing an intent count the shared intent once", () => {
    const req = discoveryRequest();
    const sharedIntent = { airports: ["DEL", "SFO"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers };
    const uniqueIntent = { airports: ["DEL", "NRT"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers };
    const digest1 = "digest-1";
    const digest2 = "digest-2";

    const record1 = ExecutionAttemptRecordSchema.parse({
      requestId: req.requestId,
      trustedContextDigest: digest1,
      attemptedIntents: [sharedIntent],
      consumedIntentCount: 1,
    });
    const record2 = ExecutionAttemptRecordSchema.parse({
      requestId: req.requestId,
      trustedContextDigest: digest2,
      attemptedIntents: [sharedIntent, uniqueIntent],
      consumedIntentCount: 2,
    });

    const ledger = ExecutionLedgerSchema.parse({
      kind: "execution_ledger",
      requestId: req.requestId,
      records: [record1, record2],
    });

    // Sum of per-record dedup = 1 + 2 = 3, but union = 2 (sharedIntent counted once).
    expect(consumedIntents(ledger)).toBe(2);
    expect(consumedIntents(ledger)).toBeLessThan(record1.consumedIntentCount + record2.consumedIntentCount);
  });
});

// ---------------------------------------------------------------------------
// 7. over-consumption: consumed > maxProviderIntents -> E0 rejects all
// ---------------------------------------------------------------------------

describe("E3 ledger — over-consumption surfaced to E0", () => {
  it("consumed > maxProviderIntents feeds nextBudget, E0 rejects all jobs with budget_exhausted + replay_budget_capped", () => {
    const req = discoveryRequest();
    // Build a ledger with 5 consumed intents.
    const intents = [
      { airports: ["DEL", "SFO"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers },
      { airports: ["DEL", "NRT"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers },
      { airports: ["DEL", "BOM"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers },
      { airports: ["DEL", "DXB"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers },
      { airports: ["DEL", "LHR"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers },
    ];
    const record = ExecutionAttemptRecordSchema.parse({
      requestId: req.requestId,
      trustedContextDigest: "digest-overconsumed",
      attemptedIntents: intents,
      consumedIntentCount: 5,
    });
    const ledger = ExecutionLedgerSchema.parse({ kind: "execution_ledger", requestId: req.requestId, records: [record] });

    // Policy with maxProviderIntents = 2 (less than consumed = 5).
    const policy = LedgerBudgetPolicySchema.parse({ maxProviderIntents: 2, maxCandidateAgeMs: 300_000 });
    const budget = nextBudget(ledger, policy);

    // consumed (5) > max (2): this is surfaced in alreadyConsumedIntents, not clamped.
    expect(budget.alreadyConsumedIntents).toBe(5);
    expect(budget.maxProviderIntents).toBe(2);

    const ctx = trustedExecutionContext({ budget });
    const plan = planVerificationJobs(req, [verificationCandidate(["DEL", "SFO"])], defaultPolicy());
    const result = validatePlanForExecution(plan, ctx);

    // E0 rejects all request_intent jobs with budget_exhausted.
    const requestIntentJobs = plan.jobs.filter(j => j.requestIntent.departure.kind === "request_intent");
    if (requestIntentJobs.length > 0) {
      expect(result.admissibleJobIds).toEqual([]);
      const budgetExhaustedDecisions = result.decisions.filter(d => d.status === "rejected" && d.reason === "budget_exhausted");
      expect(budgetExhaustedDecisions.length).toBeGreaterThan(0);
      expect(result.diagnostics).toContain("replay_budget_capped");
    }
  });
});

// ---------------------------------------------------------------------------
// 8. within-record consumedIntentCount disagreeing with deduped attemptedIntents FAILS parse
// ---------------------------------------------------------------------------

describe("E3 ledger — within-record count validation", () => {
  it("within-record consumedIntentCount disagreeing with deduped attemptedIntents FAILS parse", () => {
    const req = discoveryRequest();
    const intent = { airports: ["DEL", "SFO"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers };
    const result = ExecutionAttemptRecordSchema.safeParse({
      requestId: req.requestId,
      trustedContextDigest: "digest-abc",
      attemptedIntents: [intent],
      consumedIntentCount: 99, // wrong — should be 1
    });
    expect(result.success).toBe(false);
  });

  it("within-record consumedIntentCount with duplicate intents (dedup to fewer) FAILS parse", () => {
    const req = discoveryRequest();
    const intent = { airports: ["DEL", "SFO"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers };
    // Two identical intents deduplicate to 1 unique, but consumedIntentCount = 2.
    const result = ExecutionAttemptRecordSchema.safeParse({
      requestId: req.requestId,
      trustedContextDigest: "digest-abc",
      attemptedIntents: [intent, intent],
      consumedIntentCount: 2, // wrong — deduped count is 1
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. ordering determinism
// ---------------------------------------------------------------------------

describe("E3 ledger — ordering determinism", () => {
  it("same records in different insertion order produce identical consumedIntents and nextBudget", () => {
    const req = discoveryRequest();
    const intent1 = { airports: ["DEL", "SFO"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers };
    const intent2 = { airports: ["DEL", "NRT"], departure: { kind: "request_intent" as const, intent: req.departure }, passengers: req.passengers };

    const record1 = ExecutionAttemptRecordSchema.parse({ requestId: req.requestId, trustedContextDigest: "d1", attemptedIntents: [intent1], consumedIntentCount: 1 });
    const record2 = ExecutionAttemptRecordSchema.parse({ requestId: req.requestId, trustedContextDigest: "d2", attemptedIntents: [intent2], consumedIntentCount: 1 });

    const ledgerAB = ExecutionLedgerSchema.parse({ kind: "execution_ledger", requestId: req.requestId, records: [record1, record2] });
    const ledgerBA = ExecutionLedgerSchema.parse({ kind: "execution_ledger", requestId: req.requestId, records: [record2, record1] });

    const policy = LedgerBudgetPolicySchema.parse({ maxProviderIntents: 100, maxCandidateAgeMs: 300_000 });

    expect(consumedIntents(ledgerAB)).toBe(consumedIntents(ledgerBA));
    expect(nextBudget(ledgerAB, policy)).toEqual(nextBudget(ledgerBA, policy));
  });
});

// ---------------------------------------------------------------------------
// 10. requestId mismatch in a record FAILS parse, recordAttempt mismatch throws
// ---------------------------------------------------------------------------

describe("E3 ledger — requestId mismatch", () => {
  it("record with different requestId than ledger FAILS ExecutionLedgerSchema.parse", () => {
    const record = executionAttemptRecord();
    const result = ExecutionLedgerSchema.safeParse({
      kind: "execution_ledger",
      requestId: "different-request-id",
      records: [record],
    });
    expect(result.success).toBe(false);
  });

  it("recordAttempt with mismatched requestId throws", () => {
    const ledger = emptyLedger("request-1");
    const attempt = executionAttemptRecord({ requestId: "different-request-id" });
    expect(() => recordAttempt(ledger, attempt)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. content-key proof: records differing only in a local hypothetical index
//     but identical canonical intents+digest collide on attemptKey
// ---------------------------------------------------------------------------

describe("E3 ledger — content-key proof", () => {
  it("two records with identical canonical content collide on attemptKey", () => {
    const record1 = executionAttemptRecord();
    // Build a second record with the same content — they must share the same attemptKey.
    const record2 = ExecutionAttemptRecordSchema.parse({
      requestId: record1.requestId,
      trustedContextDigest: record1.trustedContextDigest,
      attemptedIntents: [...record1.attemptedIntents],
      consumedIntentCount: record1.consumedIntentCount,
    });
    expect(attemptKey(record1)).toBe(attemptKey(record2));
  });

  it("two records with different trustedContextDigest have different attemptKey", () => {
    const record1 = executionAttemptRecord({ trustedContextDigest: "digest-A" });
    const record2 = executionAttemptRecord({ trustedContextDigest: "digest-B" });
    expect(attemptKey(record1)).not.toBe(attemptKey(record2));
  });
});

// ---------------------------------------------------------------------------
// 12. freezeDeep — no input mutation
// ---------------------------------------------------------------------------

describe("E3 ledger — no input mutation (freezeDeep)", () => {
  it("all fold and recordAttempt operations do not throw with frozen inputs and leave inputs unchanged", () => {
    const ledger = executionLedger();
    const attempt = executionAttemptRecord({ trustedContextDigest: "new-digest" });
    const policy = LedgerBudgetPolicySchema.parse({ maxProviderIntents: 100, maxCandidateAgeMs: 300_000 });

    const ledgerBefore = structuredClone(ledger);
    const attemptBefore = structuredClone(attempt);

    freezeDeep(ledger);
    freezeDeep(attempt);

    expect(() => consumedIntents(ledger)).not.toThrow();
    expect(() => nextBudget(ledger, policy)).not.toThrow();
    expect(() => recordAttempt(ledger, attempt)).not.toThrow();

    expect(ledger).toEqual(ledgerBefore);
    expect(attempt).toEqual(attemptBefore);
  });
});

// ---------------------------------------------------------------------------
// 13. by-construction: no Date.now/Math.random in ledger.ts
// ---------------------------------------------------------------------------

describe("E3 ledger — purity by construction", () => {
  it("ledger.ts contains no Date.now or Math.random calls", () => {
    const text = readFileSync(new URL("../packages/composer/src/ledger.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/Date\.now\s*\(/);
    expect(text).not.toMatch(/Math\.random\s*\(/);
  });

  it("ledger.ts does not import from execution.ts validatePlanForExecution (data flows E3->E0, not back)", () => {
    const text = readFileSync(new URL("../packages/composer/src/ledger.ts", import.meta.url), "utf8");
    // Should not import validatePlanForExecution from execution.
    expect(text).not.toMatch(/validatePlanForExecution/);
  });

  it("ledger.ts does not import from itself or non-allowed modules", () => {
    const text = readFileSync(new URL("../packages/composer/src/ledger.ts", import.meta.url), "utf8");
    const imports = [...text.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)].map(m => m[1]);
    const allowed = ["@flightbrain/domain", "./contracts", "./execution", "zod"];
    expect(imports.every(name => allowed.includes(name))).toBe(true);
  });
});
