import { z } from "zod";
import {
  ConnectionProtectionFactSchema,
  ProtectionStateSchema,
  type ConnectionProtectionFact,
  type ProtectionState,
} from "@flightbrain/domain";

// Schedule fingerprint validation (V1 regex, single-sourced contract)
// E5 NEVER computes fingerprints; it only accepts and carries a caller-supplied value.
const FingerprintV1Schema = z
  .string()
  .regex(/^fb:schedule:v1:[a-f0-9]{64}(?![\s\S])/, "Must be a valid fb:schedule:v1 fingerprint");

// Mirrors the domain private IdSchema: nonblank, no leading/trailing whitespace, no control chars.
const IdSchema = z
  .string()
  .min(1)
  .refine(
    (s) => s.trim() === s && !/[\u0000-\u001f\u007f]/.test(s),
    "Must be a nonblank string without leading/trailing whitespace or control characters",
  );

export const SingleTicketEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("same_component"),
    provider: IdSchema,
    providerOfferId: IdSchema,
    reference: IdSchema,
  }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type SingleTicketEvidence = z.infer<typeof SingleTicketEvidenceSchema>;

const IndexSchema = z.number().int().nonnegative();

export const ConnectionBoundaryInputSchema = z.strictObject({
  journeyIndex: IndexSchema,
  fromSegmentIndex: IndexSchema,
  fromComponentIndex: IndexSchema,
  toComponentIndex: IndexSchema,
  evidence: SingleTicketEvidenceSchema,
});
export type ConnectionBoundaryInput = z.infer<typeof ConnectionBoundaryInputSchema>;

export const ProtectionAssessmentSchema = z.strictObject({
  journeyIndex: IndexSchema,
  fromSegmentIndex: IndexSchema,
  crossesBookingBoundary: z.boolean(),
  protection: ProtectionStateSchema,
  evidence: SingleTicketEvidenceSchema,
});
export type ProtectionAssessment = z.infer<typeof ProtectionAssessmentSchema>;

const ItineraryProtectionResultBaseSchema = z.strictObject({
  scheduleFingerprint: FingerprintV1Schema.nullable(),
  assessments: z.array(ProtectionAssessmentSchema),
  protectionFacts: z.array(ConnectionProtectionFactSchema),
});

export const ItineraryProtectionResultSchema = ItineraryProtectionResultBaseSchema.superRefine(
  (result, ctx) => {
    if (!ItineraryProtectionResultBaseSchema.safeParse(result).success) return;
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const assessment of result.assessments) {
      if (assessment.protection === "protected") {
        if (assessment.evidence.kind !== "same_component") {
          issue(
            "Assessment at journey " + assessment.journeyIndex + " fromSegment " + assessment.fromSegmentIndex +
              " claims protected but evidence is " + assessment.evidence.kind + ", expected same_component",
          );
        }
        if (assessment.crossesBookingBoundary) {
          issue(
            "Assessment at journey " + assessment.journeyIndex + " fromSegment " + assessment.fromSegmentIndex +
              " claims protected but crosses a booking boundary",
          );
        }
      }
      if (assessment.protection === "unknown" && assessment.evidence.kind === "same_component") {
        issue(
          "Assessment at journey " + assessment.journeyIndex + " fromSegment " + assessment.fromSegmentIndex +
            " claims unknown but has same_component evidence",
        );
      }
    }
    for (const fact of result.protectionFacts) {
      // Only within-component "protected" connections are ever emitted as facts, and every
      // fact must trace back to a matching assessment. Harden the validator so a hand-crafted
      // result cannot carry an orphan or non-protected fact the producer would never emit.
      if (fact.protection !== "protected") {
        issue(
          "protectionFact at journey " + fact.journeyIndex + " fromSegment " + fact.fromSegmentIndex +
            " has protection " + fact.protection + ", but only protected connections are emitted as facts",
        );
      }
      const assessment = result.assessments.find(
        (a) => a.journeyIndex === fact.journeyIndex && a.fromSegmentIndex === fact.fromSegmentIndex,
      );
      if (assessment === undefined) {
        issue(
          "protectionFact at journey " + fact.journeyIndex + " fromSegment " + fact.fromSegmentIndex +
            " has no matching assessment",
        );
      } else if (assessment.protection !== fact.protection) {
        issue(
          "protectionFact at journey " + fact.journeyIndex + " fromSegment " + fact.fromSegmentIndex +
            " has protection " + fact.protection + " but assessment says " + assessment.protection,
        );
      }
    }
  },
);
export type ItineraryProtectionResult = z.infer<typeof ItineraryProtectionResultSchema>;

/**
 * Pure core rule: turns a single connection boundary into a ProtectionAssessment.
 * Rules:
 * 1. fromComponentIndex !== toComponentIndex: self_transfer (structural boundary wins)
 * 2. Same component + evidence.kind === "same_component" with nonblank reference: protected
 * 3. Same component + evidence.kind === "none": unknown
 */
export function assessConnectionProtection(boundary: ConnectionBoundaryInput): ProtectionAssessment {
  const parsed = ConnectionBoundaryInputSchema.parse(boundary);
  const crossesBookingBoundary = parsed.fromComponentIndex !== parsed.toComponentIndex;

  let protection: ProtectionState;
  let outEvidence: SingleTicketEvidence;

  if (crossesBookingBoundary) {
    protection = "self_transfer";
    outEvidence = { kind: "none" };
  } else if (parsed.evidence.kind === "same_component") {
    protection = "protected";
    outEvidence = parsed.evidence;
  } else {
    protection = "unknown";
    outEvidence = { kind: "none" };
  }

  return ProtectionAssessmentSchema.parse({
    journeyIndex: parsed.journeyIndex,
    fromSegmentIndex: parsed.fromSegmentIndex,
    crossesBookingBoundary,
    protection,
    evidence: outEvidence,
  });
}

export interface AssessItineraryProtectionInput {
  scheduleFingerprint: string | null;
  boundaries: ConnectionBoundaryInput[];
}

/**
 * Folds connection boundaries into an ItineraryProtectionResult.
 * Validates and carries the caller-supplied schedule fingerprint (or null).
 * Emits ConnectionProtectionFact[] for the within-component, protected-only subset.
 */
export function assessItineraryProtection(
  input: AssessItineraryProtectionInput,
): ItineraryProtectionResult {
  if (input.scheduleFingerprint !== null) {
    const fingerprintResult = FingerprintV1Schema.safeParse(input.scheduleFingerprint);
    if (!fingerprintResult.success) {
      throw new Error(
        "Invalid scheduleFingerprint: " + fingerprintResult.error.issues.map((i) => i.message).join("; "),
      );
    }
  }

  const scheduleFingerprint: string | null = input.scheduleFingerprint;
  const assessments: ProtectionAssessment[] = input.boundaries.map((b) => assessConnectionProtection(b));

  const protectionFacts: ConnectionProtectionFact[] = [];
  for (const assessment of assessments) {
    if (
      !assessment.crossesBookingBoundary &&
      assessment.evidence.kind === "same_component" &&
      assessment.protection === "protected"
    ) {
      protectionFacts.push(
        ConnectionProtectionFactSchema.parse({
          journeyIndex: assessment.journeyIndex,
          fromSegmentIndex: assessment.fromSegmentIndex,
          protection: "protected",
          reference: assessment.evidence.reference,
        }),
      );
    }
  }

  return ItineraryProtectionResultSchema.parse({ scheduleFingerprint, assessments, protectionFacts });
}
