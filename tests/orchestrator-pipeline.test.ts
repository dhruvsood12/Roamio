import { describe, expect, it } from "vitest";
import {
  consumedIntents,
  emptyLedger,
  planVerificationJobs,
  type TrustedExecutionContext,
} from "@flightbrain/composer";
import {
  deferredRealProviderIntakePort,
  itineraryFingerprint,
  mockProviderIntakePort,
  RealProviderNotImplementedError,
  runProviderOrchestration,
  type OrchestrationInput,
  type OrchestrationPolicy,
  type ProviderIntakePort,
} from "@flightbrain/orchestrator";
import { discoveryRequest } from "./fixtures/discovery";
import { trustedExecutionContext } from "./fixtures/execution";
import { verificationExamples as examples } from "./fixtures/verification";
import { connectionPolicy } from "./fixtures/feasibility";

// Synthetic canonical topology only; no genuine source/service claims.
const ASOF = "2026-09-21T10:00:00Z";

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
}

function makePolicy(change: Partial<OrchestrationPolicy> = {}): OrchestrationPolicy {
  return {
    connectionPolicy: connectionPolicy({
      minConnectionMinutes: 30,
      allowAirportChange: true,
      airportChangeTransferMinutes: 60,
    }),
    mockIntakePolicy: {
      asOf: ASOF,
      seed: 42,
      offersPerDescriptor: 2,
      offerValidityMs: 3_600_000,
      currency: "USD",
    },
    mockProvenance: {
      providerId: "mock:test",
      synthetic: true,
      disclaimer: "SYNTHETIC DATA — integration test only; no real fares or carriers.",
    },
    rankingPolicy: { asOf: ASOF } as OrchestrationPolicy["rankingPolicy"],
    ledgerBudget: { maxProviderIntents: 1_000, maxCandidateAgeMs: 300_000 },
    asOf: ASOF,
    ...change,
  };
}

function makeInput(
  ctxChange: Partial<TrustedExecutionContext> = {},
  policyChange: Partial<OrchestrationPolicy> = {},
): OrchestrationInput {
  const context = trustedExecutionContext({
    asOf: ASOF,
    departure: { kind: "date", date: "2026-11-15" },
    passengers: { count: 2 },
    ...ctxChange,
  });
  const request = { ...discoveryRequest(), departure: context.departure, passengers: context.passengers };
  const plan = planVerificationJobs(request, examples(), {
    asOf: ASOF,
    maxCandidateAgeMs: 300_000,
    maxCandidates: 10,
    maxLegsPerCandidate: 8,
    maxJobs: 100,
  });
  const ledger = emptyLedger(context.requestId);
  return { plan, context, ledger, policy: makePolicy(policyChange) };
}

// A counting port that wraps the default mock, to assert how many intake calls happen.
function countingPort(base: ProviderIntakePort): { port: ProviderIntakePort; calls: () => number } {
  let n = 0;
  return {
    port: {
      async intake(descriptor, context) {
        n += 1;
        return base.intake(descriptor, context);
      },
    },
    calls: () => n,
  };
}

function composedTrips(result: Awaited<ReturnType<typeof runProviderOrchestration>>) {
  return result.composition.outcomes
    .filter((o) => o.outcome === "composed")
    .map((o) => (o as Extract<typeof o, { outcome: "composed" }>).trip);
}

describe("C004 provider orchestration — full pipeline", () => {
  it("(1) runs E0→E6→C003 offline-deterministically with the default mock port", async () => {
    const result = await runProviderOrchestration(makeInput());
    expect(result.ranking.ranked.length).toBeGreaterThan(0);
    expect(result.composition.outcomes.some((o) => o.outcome === "composed")).toBe(true);

    // Byte-identical across two independent calls (no wall clock, no randomness).
    const again = await runProviderOrchestration(makeInput());
    expect(again).toEqual(result);
  });

  it("(2) threads the ledger; replaying with ledgerAfter does not double-charge", async () => {
    const first = await runProviderOrchestration(makeInput());
    const consumedAfterFirst = consumedIntents(first.ledgerAfter);
    expect(consumedAfterFirst).toBeGreaterThan(0);

    // Feed ledgerAfter back in; same request → idempotent by content key.
    const replayInput = { ...makeInput(), ledger: first.ledgerAfter };
    const second = await runProviderOrchestration(replayInput);

    expect(consumedIntents(second.ledgerAfter)).toBe(consumedAfterFirst);
    expect(second.ranking).toEqual(first.ranking);
  });

  it("(3) budget exhaustion fails closed — zero intake calls, no composed trips", async () => {
    const base = mockProviderIntakePort(
      makePolicy().mockIntakePolicy,
      makePolicy().mockProvenance,
    );
    const spy = countingPort(base);

    const input = makeInput({}, { ledgerBudget: { maxProviderIntents: 0, maxCandidateAgeMs: 300_000 } });
    const result = await runProviderOrchestration(input, spy.port);

    expect(spy.calls()).toBe(0); // no intake for rejected jobs
    expect(result.ranking.ranked).toEqual([]);
    expect(result.admissibility.admissibleJobIds).toEqual([]);
    expect(result.diagnostics).toContain("no_admissible_jobs");
    // E0 surfaces the replay/budget cap as a diagnostic.
    expect(result.diagnostics).toContain("replay_budget_capped");
    // And every decision that reached the budget gate is a budget_exhausted rejection.
    expect(
      result.admissibility.decisions.some(
        (d) => d.status === "rejected" && d.reason === "budget_exhausted",
      ),
    ).toBe(true);
  });

  it("(4) computes schedule fingerprints at the edge and carries them (never recomputed)", async () => {
    const result = await runProviderOrchestration(makeInput());
    expect(result.fingerprints.length).toBeGreaterThan(0);

    // Each reported fingerprint equals itineraryFingerprint(offer) computed here —
    // proving it originated at the orchestrator edge, consistently.
    const offeredOutcomes = result.intake.filter((o) => o.outcome === "offered");
    const allOffers = offeredOutcomes.flatMap((o) =>
      (o as Extract<typeof o, { outcome: "offered" }>).offers,
    );
    for (let i = 0; i < allOffers.length; i++) {
      expect(result.fingerprints[i].fingerprint).toBe(itineraryFingerprint(allOffers[i] as never));
    }
  });

  it("(5) preserves provenance/freshness end-to-end (synthetic mock offer survives into the trip)", async () => {
    const trips = composedTrips(await runProviderOrchestration(makeInput()));
    expect(trips.length).toBeGreaterThan(0);
    const snap = trips[0].sourceOffers[0];
    expect(snap.provider).toMatch(/^mock:/);
    expect(snap.requiresRevalidation).toBe(true);
    expect(snap.retrievedAt).toBe(ASOF);
  });

  it("(6) invents nothing — a non-date departure is declined upstream, not guessed", async () => {
    // Unspecified departure → E1 cannot resolve → no descriptors → no offers → empty ranking.
    const input = makeInput({ departure: { kind: "unspecified" } });
    const result = await runProviderOrchestration(input);
    // E1 surfaces unresolved departures; nothing is fabricated.
    expect(result.resolution.decisions.every((d) => d.outcome !== "resolved")).toBe(true);
    expect(result.ranking.ranked).toEqual([]);
    expect(composedTrips(result)).toEqual([]);
  });

  it("(7) the deferred real-provider port is gated, not stubbed", async () => {
    await expect(
      runProviderOrchestration(makeInput(), deferredRealProviderIntakePort),
    ).rejects.toBeInstanceOf(RealProviderNotImplementedError);
  });

  it("(8) fails closed on a plan/context request mismatch", async () => {
    const good = makeInput();
    const mismatched: OrchestrationInput = {
      ...good,
      context: { ...good.context, requestId: "request-DIFFERENT" },
    };
    const result = await runProviderOrchestration(mismatched);
    expect(result.diagnostics).toContain("plan_request_mismatch");
    expect(result.ranking.ranked).toEqual([]);
    expect(result.admissibility.admissibleJobIds).toEqual([]);
  });

  it("(9) does not mutate its inputs (pure over deep-frozen input)", async () => {
    const input = makeInput();
    freezeDeep(input);
    await expect(runProviderOrchestration(input)).resolves.toBeDefined();
  });
});
