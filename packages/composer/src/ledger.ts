import { z } from "zod";
import { RouteDiscoveryRequestSchema } from "@flightbrain/domain";
import { VerificationRequestIntentSchema, verificationIntentKey } from "./contracts";
import { ExecutionBudgetSchema, type ExecutionBudget } from "./execution";

const CountSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// ExecutionAttemptRecord
// ---------------------------------------------------------------------------

const ExecutionAttemptRecordBaseSchema = z.strictObject({
  requestId: RouteDiscoveryRequestSchema.shape.requestId,
  trustedContextDigest: z.string(),
  attemptedIntents: z.array(VerificationRequestIntentSchema),
  consumedIntentCount: CountSchema,
});

export const ExecutionAttemptRecordSchema = ExecutionAttemptRecordBaseSchema.superRefine((record, ctx) => {
  if (!ExecutionAttemptRecordBaseSchema.safeParse(record).success) return;
  // consumedIntentCount must equal the count of de-duplicated attemptedIntents.
  const deduped = new Set(record.attemptedIntents.map(intent => verificationIntentKey(intent)));
  if (record.consumedIntentCount !== deduped.size) {
    ctx.addIssue({
      code: "custom",
      message: `consumedIntentCount (${record.consumedIntentCount}) must equal the count of de-duplicated attemptedIntents (${deduped.size})`,
    });
  }
});

export type ExecutionAttemptRecord = z.infer<typeof ExecutionAttemptRecordSchema>;

// Content-derived idempotency key — NOT jobId/candidateIndex.
export function attemptKey(attempt: ExecutionAttemptRecord): string {
  return JSON.stringify(ExecutionAttemptRecordSchema.parse(attempt));
}

// ---------------------------------------------------------------------------
// ExecutionLedger
// ---------------------------------------------------------------------------

const ExecutionLedgerBaseSchema = z.strictObject({
  kind: z.literal("execution_ledger"),
  requestId: RouteDiscoveryRequestSchema.shape.requestId,
  records: z.array(ExecutionAttemptRecordSchema),
});

export const ExecutionLedgerSchema = ExecutionLedgerBaseSchema.superRefine((ledger, ctx) => {
  if (!ExecutionLedgerBaseSchema.safeParse(ledger).success) return;
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });

  // (a) All records must share ledger.requestId.
  for (const record of ledger.records) {
    if (record.requestId !== ledger.requestId) {
      issue(`Record requestId "${record.requestId}" does not match ledger requestId "${ledger.requestId}"`);
      return; // Stop on first mismatch to avoid flooding issues.
    }
  }

  // (b) No two records share the same attemptKey (duplicate rejection, order-independent).
  const seen = new Set<string>();
  for (const record of ledger.records) {
    const key = attemptKey(record);
    if (seen.has(key)) {
      issue("Duplicate attempt record detected — records must be content-distinct");
      return;
    }
    seen.add(key);
  }
});

export type ExecutionLedger = z.infer<typeof ExecutionLedgerSchema>;

// ---------------------------------------------------------------------------
// Pure folds
// ---------------------------------------------------------------------------

// Size of the UNION of verificationIntentKey(intent) across ALL records' attemptedIntents.
// An intent executed in two attempts counts ONCE (anti-double-count).
export function consumedIntents(ledger: ExecutionLedger): number {
  const union = new Set<string>();
  for (const record of ledger.records) {
    for (const intent of record.attemptedIntents) {
      union.add(verificationIntentKey(intent));
    }
  }
  return union.size;
}

// ---------------------------------------------------------------------------
// LedgerBudgetPolicy
// ---------------------------------------------------------------------------

export const LedgerBudgetPolicySchema = z.strictObject({
  maxProviderIntents: ExecutionBudgetSchema.shape.maxProviderIntents,
  maxCandidateAgeMs: ExecutionBudgetSchema.shape.maxCandidateAgeMs,
});

export type LedgerBudgetPolicy = z.infer<typeof LedgerBudgetPolicySchema>;

// ---------------------------------------------------------------------------
// nextBudget — maps ledger + policy to ExecutionBudget for E0
// ---------------------------------------------------------------------------

// If consumed > max the parse still succeeds; E0 then rejects via
// budget_exhausted/replay_budget_capped — surfaced, never clamped.
export function nextBudget(ledger: ExecutionLedger, policy: LedgerBudgetPolicy): ExecutionBudget {
  return ExecutionBudgetSchema.parse({
    maxProviderIntents: policy.maxProviderIntents,
    alreadyConsumedIntents: consumedIntents(ledger),
    maxCandidateAgeMs: policy.maxCandidateAgeMs,
  });
}

// ---------------------------------------------------------------------------
// recordAttempt — pure, returns a NEW strict-parsed ledger
// ---------------------------------------------------------------------------

export function recordAttempt(ledger: ExecutionLedger, attempt: ExecutionAttemptRecord): ExecutionLedger {
  // requestId mismatch: throw immediately.
  if (attempt.requestId !== ledger.requestId) {
    throw new Error(
      `Cannot record attempt with requestId "${attempt.requestId}" into ledger for requestId "${ledger.requestId}"`,
    );
  }

  // Idempotent replay: if attemptKey already present, return ledger unchanged.
  const key = attemptKey(attempt);
  for (const existing of ledger.records) {
    if (attemptKey(existing) === key) {
      return ledger;
    }
  }

  // Pure: construct a new ledger with the new record appended.
  return ExecutionLedgerSchema.parse({
    kind: "execution_ledger",
    requestId: ledger.requestId,
    records: [...ledger.records, attempt],
  });
}

// ---------------------------------------------------------------------------
// emptyLedger — convenience, consumedIntents -> 0
// ---------------------------------------------------------------------------

export function emptyLedger(requestId: string): ExecutionLedger {
  return ExecutionLedgerSchema.parse({
    kind: "execution_ledger",
    requestId,
    records: [],
  });
}
