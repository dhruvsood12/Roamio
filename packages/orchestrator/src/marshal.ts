/**
 * C004 marshal.ts — index-space translation and policy bundling.
 *
 * KEY ENGINEERING: E2 keys on candidateIndex/legIndex (route/plan space) while
 * E6/ComposedFeasibilityInput keys on trip journeyIndex/segmentIndex (offer/segment space).
 * For each offered job:
 *   - The offer maps to one booking component (component 0).
 *   - Its journeys[].segments map 1:1 to TravelSegmentRef{componentIndex:0, journeyIndex, segmentIndex}.
 *   - Each intra-offer connection segment i→i+1 becomes both an E2 evaluation (from arrival at
 *     segment i to departure at segment i+1) and an E5 ConnectionBoundaryInput.
 *   - E6 ComposedFeasibilityInput decisions are keyed in TRIP space (journeyIndex, fromSegmentIndex).
 *
 * Offers are FlightOfferSchema-validated before marshalling, so segment instants are
 * always present (SegmentSchema.departureAt/arrivalAt are non-nullable). Every intra-journey
 * connection is therefore evaluated by E2; no synthetic MCT/transfer values are invented,
 * and an infeasible/unknown E2 verdict is what makes E6 decline downstream.
 */

import { z } from "zod";
import {
  ConnectionPolicySchema,
  MockIntakePolicySchema,
  SyntheticProvenanceSchema,
  assessItineraryProtection,
  evaluateConnectionFeasibility,
  type AssessItineraryProtectionInput,
  type ComposedFeasibilityInput,
  type ComposedProtectionInput,
  type ConnectionBoundaryInput,
  type ConnectionFeasibilityDecision,
  type ConnectionPolicy,
  type MockIntakeOutcome,
  type MockIntakePolicy,
  type SyntheticProvenance,
  type TripCompositionRequest,
} from "@flightbrain/composer";
import {
  FlightOfferSchema,
  TravelSegmentRefSchema,
  type FlightOffer,
} from "@flightbrain/domain";
import { TripRankingPolicySchema, type TripRankingPolicy } from "@flightbrain/ranking";
import { LedgerBudgetPolicySchema, type LedgerBudgetPolicy } from "@flightbrain/composer";
import { itineraryFingerprint, groupOffersByItinerary } from "./schedule";
import type { ScheduleFingerprint } from "./schedule";

// ---------------------------------------------------------------------------
// OrchestrationPolicySchema — bundles all per-pipeline policy knobs
// ---------------------------------------------------------------------------

export const OrchestrationPolicySchema = z.strictObject({
  /** Connection feasibility policy (E2). */
  connectionPolicy: ConnectionPolicySchema,
  /** E4 mock intake policy (used when port = mockProviderIntakePort). */
  mockIntakePolicy: MockIntakePolicySchema,
  /** E4 provenance (used when port = mockProviderIntakePort). */
  mockProvenance: SyntheticProvenanceSchema,
  /** C003 ranking policy. */
  rankingPolicy: TripRankingPolicySchema,
  /** Ledger budget (for nextBudget). */
  ledgerBudget: LedgerBudgetPolicySchema,
  /**
   * Injected pipeline clock. All timestamps in E0/E1/E2/E5/E6/C003 must
   * derive from this value — never Date.now().
   */
  asOf: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)),
});
export type OrchestrationPolicy = z.infer<typeof OrchestrationPolicySchema>;

// ---------------------------------------------------------------------------
// FingerprintConflictReasonSchema
// ---------------------------------------------------------------------------

export const FingerprintConflictReasonSchema = z.enum([
  "fingerprint_mismatch_within_job",
]);
export type FingerprintConflictReason = z.infer<typeof FingerprintConflictReasonSchema>;

// ---------------------------------------------------------------------------
// computeOfferFingerprints
// Edge fingerprinting: called exactly once per intake outcome.
// Uses frozen itineraryFingerprint + groupOffersByItinerary from schedule.ts.
// ---------------------------------------------------------------------------

export type OfferWithFingerprint = {
  offer: FlightOffer;
  fingerprint: ScheduleFingerprint | null;
};

/**
 * Computes schedule fingerprints for all offers in a single intake outcome.
 * Returns {offer, fingerprint}[] in the same order as the intake offers.
 * Fingerprints are computed here at the edge (never in E5/E6 which only carry them).
 */
export function computeOfferFingerprints(
  offers: readonly FlightOffer[],
): OfferWithFingerprint[] {
  // Per-offer schedule fingerprint via the frozen edge function (schedule.ts).
  return offers.map((offer) => ({
    offer,
    fingerprint: itineraryFingerprint(offer),
  }));
}

// ---------------------------------------------------------------------------
// Index-space translation helpers
// ---------------------------------------------------------------------------

/**
 * For a single-component offer (one FlightOffer per job), the trip journey/segment
 * indices map 1:1 to the offer's journey/segment indices:
 *   TravelSegmentRef{ componentIndex: 0, journeyIndex: j, segmentIndex: s }
 * corresponds to offer.journeys[j].segments[s].
 *
 * Connections within a journey: segment[s] → segment[s+1] gives fromSegmentIndex=s.
 * For a single-journey offer: all segments in journeys[0].
 */

/**
 * Build the list of all intra-journey connections in an offer.
 * Each connection is: journeyIndex j, fromSegmentIndex s, arrival at segment[s], departure at segment[s+1].
 * Only segments within the same journey can connect (inter-journey connections are separate tickets).
 */
function offerConnections(offer: FlightOffer): Array<{
  journeyIndex: number;
  fromSegmentIndex: number;
  arrivalAt: string;
  departureAt: string;
}> {
  const connections: Array<{
    journeyIndex: number;
    fromSegmentIndex: number;
    arrivalAt: string;
    departureAt: string;
  }> = [];
  for (let ji = 0; ji < offer.journeys.length; ji++) {
    const journey = offer.journeys[ji];
    for (let si = 0; si < journey.segments.length - 1; si++) {
      const fromSeg = journey.segments[si];
      const toSeg = journey.segments[si + 1];
      // Instants are schema-guaranteed non-null on a parsed FlightOffer.
      connections.push({
        journeyIndex: ji,
        fromSegmentIndex: si,
        arrivalAt: fromSeg.arrivalAt,
        departureAt: toSeg.departureAt,
      });
    }
  }
  return connections;
}

// ---------------------------------------------------------------------------
// toFeasibilityInput
// Translates offer connections to ComposedFeasibilityInput keyed in trip space.
// Uses E2 evaluateConnectionFeasibility for each connection.
// FAIL-CLOSED: missing instants → unknown decision → E6 infeasible_connection.
// ---------------------------------------------------------------------------

export function toFeasibilityInput(
  offer: FlightOffer,
  policy: ConnectionPolicy,
  jobId: number,
): ComposedFeasibilityInput {
  const connections = offerConnections(offer);
  const decisions: ComposedFeasibilityInput["decisions"] = [];

  for (const conn of connections) {
    // Offers are schema-validated (non-null instants) before this point, so every
    // connection is evaluated by E2. E2 evaluation in offer space: candidateIndex = jobId,
    // legIndex = fromSegmentIndex. VerifiedPrefixArrivalFact/DependentDepartureFact are
    // synthesized from offer data only — no invented MCT/transfer values.
    const arrivalFact = {
      candidateIndex: jobId,
      precedingLegIndex: conn.fromSegmentIndex,
      arrivalAirport: offer.journeys[conn.journeyIndex].segments[conn.fromSegmentIndex].destination,
      arrivalAt: conn.arrivalAt,
      evidenceLevel: "scheduled" as const,
      provenance: null,
    };
    const departureFact = {
      candidateIndex: jobId,
      legIndex: conn.fromSegmentIndex + 1,
      departureAirport: offer.journeys[conn.journeyIndex].segments[conn.fromSegmentIndex + 1].origin,
      earliestDepartureAt: conn.departureAt,
      evidenceLevel: "scheduled" as const,
    };
    const decision: ConnectionFeasibilityDecision = evaluateConnectionFeasibility(
      arrivalFact,
      departureFact,
      policy,
    );

    // Key in TRIP space: journeyIndex and fromSegmentIndex are the same for single-component trips
    // because the offer's journeys map 1:1 to trip journeys.
    decisions.push({
      journeyIndex: conn.journeyIndex,
      fromSegmentIndex: conn.fromSegmentIndex,
      decision,
    });
  }

  return { decisions };
}

// ---------------------------------------------------------------------------
// toProtectionInput
// Builds the E5 AssessItineraryProtectionInput.
// For a single-component offer: all connections are within-component (component 0 → 0).
// The schedule fingerprint is carried from the edge computation.
// ---------------------------------------------------------------------------

export function toProtectionInput(
  offer: FlightOffer,
  fingerprint: ScheduleFingerprint | null,
  jobId: number,
): AssessItineraryProtectionInput {
  const connections = offerConnections(offer);
  const boundaries: ConnectionBoundaryInput[] = connections.map((conn) => ({
    journeyIndex: conn.journeyIndex,
    fromSegmentIndex: conn.fromSegmentIndex,
    // Single-component offer: all connections are within component 0.
    fromComponentIndex: 0,
    toComponentIndex: 0,
    // Single-ticket evidence: uses offer provenance.
    evidence: {
      kind: "same_component" as const,
      provider: offer.provider,
      providerOfferId: offer.providerOfferId,
      reference: `${offer.provider}:${offer.providerOfferId}:conn:${conn.journeyIndex}:${conn.fromSegmentIndex}`,
    },
  }));

  return {
    scheduleFingerprint: fingerprint,
    boundaries,
  };
}

// ---------------------------------------------------------------------------
// toTripCompositionRequests
// Translates an array of (offer, fingerprint, jobId) into TripCompositionRequest[].
// Payment = cash PaymentQuote equal to offer.totalPrice (required by TripPlanSchema).
// ---------------------------------------------------------------------------

export type OfferedJob = {
  jobId: number;
  offer: FlightOffer;
  fingerprint: ScheduleFingerprint | null;
  feasibility: ComposedFeasibilityInput;
  protection: ComposedProtectionInput;
};

export function toTripCompositionRequests(
  offeredJobs: OfferedJob[],
  requestId: string,
): TripCompositionRequest[] {
  return offeredJobs.map((job) => {
    const { jobId, offer, fingerprint, feasibility, protection } = job;

    // Build segments for a single-component binding.
    // All journeys[j].segments[s] → TravelSegmentRef{componentIndex:0, journeyIndex:j, segmentIndex:s}
    const allSegmentRefs = offer.journeys.flatMap((journey, ji) =>
      journey.segments.map((_, si) => ({
        componentIndex: 0,
        journeyIndex: ji,
        segmentIndex: si,
      })),
    );

    if (allSegmentRefs.length === 0) {
      // Should not happen for valid offers, but fail gracefully.
      throw new Error(`Offer ${offer.id} has no segments`);
    }

    // Journeys: each offer journey becomes a trip journey.
    // requestedOrigin = first segment's origin, requestedDestination = last segment's destination.
    const journeys = offer.journeys.map((journey, ji) => {
      const firstSeg = journey.segments[0];
      const lastSeg = journey.segments[journey.segments.length - 1];
      const segments = journey.segments.map((_, si) => ({
        componentIndex: 0,
        journeyIndex: ji,
        segmentIndex: si,
      }));
      return {
        requestedOrigin: firstSeg.origin,
        requestedDestination: lastSeg.destination,
        segments: segments as [typeof segments[0], ...typeof segments],
      };
    });

    // Stable trip ID derived from jobId and offer ID.
    const tripId = `trip:job:${jobId}:offer:${offer.id}`;

    return {
      id: tripId,
      jobId,
      bindings: [
        {
          sourceOffer: offer,
          provider: offer.provider,
          providerOfferId: offer.providerOfferId,
          offerId: offer.id,
          scheduleFingerprint: fingerprint,
          // Payment = cash PaymentQuote equal to offer.totalPrice exactly.
          payment: { kind: "cash" as const, amount: offer.totalPrice },
          segments: allSegmentRefs as [typeof allSegmentRefs[0], ...typeof allSegmentRefs],
        },
      ],
      journeys: journeys as [typeof journeys[0], ...typeof journeys],
      protection,
      feasibility,
    } as TripCompositionRequest;
  });
}
