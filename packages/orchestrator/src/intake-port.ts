/**
 * C004 intake-port.ts — the C006 seam.
 *
 * Defines the ProviderIntakePort interface (injected into the pipeline).
 * Default factory wraps the E4 mock (intakeMockOffers).
 * The deferred real port throws RealProviderNotImplementedError.
 */

import { z } from "zod";
import {
  MockIntakePolicySchema,
  SyntheticProvenanceSchema,
  intakeMockOffers,
  type CommercialRequestDescriptor,
  type MockIntakeOutcome,
  type MockIntakePolicy,
  type SyntheticProvenance,
} from "@flightbrain/composer";
import { TimestampSchema } from "@flightbrain/domain";

// ---------------------------------------------------------------------------
// ProviderIntakeContext — injected, no wall clock
// ---------------------------------------------------------------------------

export const ProviderIntakeContextSchema = z.strictObject({
  /** Injected asOf; never Date.now() in the core pipeline. */
  asOf: TimestampSchema,
});
export type ProviderIntakeContext = z.infer<typeof ProviderIntakeContextSchema>;

// ---------------------------------------------------------------------------
// ProviderIntakeOutcome — structurally the E4 MockIntakeOutcome re-declared
// at the port boundary so the core doesn't depend on @flightbrain/composer internals.
// ---------------------------------------------------------------------------

// Re-use the MockIntakeOutcome shape at the port level.
// (The port is allowed to import composer because this is the orchestrator package.)
export const ProviderIntakeOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("offered"),
    jobId: z.number().int().nonnegative(),
    offers: z.array(z.unknown()), // FlightOffer[] — validated downstream by E6 schemas
  }),
  z.strictObject({
    outcome: z.literal("declined"),
    jobId: z.number().int().nonnegative(),
    reason: z.string(),
  }),
]);
export type ProviderIntakeOutcome = MockIntakeOutcome; // structurally identical

// ---------------------------------------------------------------------------
// ProviderIntakePort — the injected seam interface
// ---------------------------------------------------------------------------

export interface ProviderIntakePort {
  /**
   * Given one resolved CommercialRequestDescriptor and the intake context,
   * return either an "offered" outcome with FlightOffers or a "declined" outcome.
   * Must be deterministic when given identical inputs (for offline testing).
   */
  intake(
    descriptor: CommercialRequestDescriptor,
    context: ProviderIntakeContext,
  ): Promise<MockIntakeOutcome>;
}

// ---------------------------------------------------------------------------
// Default factory: mockProviderIntakePort
// Wraps intakeMockOffers — deterministic, offline, no network.
// ---------------------------------------------------------------------------

export function mockProviderIntakePort(
  policy: MockIntakePolicy,
  provenance: SyntheticProvenance,
): ProviderIntakePort {
  const parsedPolicy = MockIntakePolicySchema.parse(policy);
  const parsedProvenance = SyntheticProvenanceSchema.parse(provenance);
  return {
    async intake(descriptor, context) {
      // Override policy.asOf with the injected context.asOf so timestamps derive
      // from the pipeline clock, not a stale baked-in asOf.
      const effectivePolicy = MockIntakePolicySchema.parse({
        ...parsedPolicy,
        asOf: context.asOf,
      });
      return intakeMockOffers(descriptor, effectivePolicy, parsedProvenance);
    },
  };
}

// ---------------------------------------------------------------------------
// Deferred real port — throws RealProviderNotImplementedError (C006 seam)
// ---------------------------------------------------------------------------

export class RealProviderNotImplementedError extends Error {
  constructor() {
    super(
      "Real provider intake is not implemented in C004. " +
      "Wire a real ProviderIntakePort in C006. " +
      "Injecting deferredRealProviderIntakePort proves the seam is gated, not stubbed.",
    );
    this.name = "RealProviderNotImplementedError";
  }
}

export const deferredRealProviderIntakePort: ProviderIntakePort = {
  async intake(_descriptor, _context): Promise<MockIntakeOutcome> {
    throw new RealProviderNotImplementedError();
  },
};
