import { z } from "zod";
import { AirportCodeSchema, RouteDiscoveryRequestSchema } from "@flightbrain/domain";
import { VerificationPlanSchema, type VerificationPlan } from "./contracts";
import {
  ExecutionAdmissibilitySchema, TrustedExecutionContextSchema, trustedContextDigest,
  type ExecutionAdmissibility, type TrustedExecutionContext,
} from "./execution";

const CountSchema = z.number().int().nonnegative();

// Preserve the canonical date/window exactly, including timestamp offsets.
export const CommercialDepartureSchema = z.discriminatedUnion("kind", [
  RouteDiscoveryRequestSchema.shape.departure.options[1],
  RouteDiscoveryRequestSchema.shape.departure.options[2],
]);
export type CommercialDeparture = z.infer<typeof CommercialDepartureSchema>;

export const CommercialRequestDescriptorSchema = z.strictObject({
  origin: AirportCodeSchema,
  destination: AirportCodeSchema,
  // Full expected path for filtering returned results, never via-airport API parameters.
  routeFilter: z.array(AirportCodeSchema).min(2),
  departure: CommercialDepartureSchema,
  // Discovery party context only; no inferred ages or adult count.
  passengers: RouteDiscoveryRequestSchema.shape.passengers,
  jobId: CountSchema,
}).superRefine((descriptor, ctx) => {
  if (descriptor.origin === descriptor.destination ||
    descriptor.origin !== descriptor.routeFilter[0] || descriptor.destination !== descriptor.routeFilter.at(-1)) {
    ctx.addIssue({ code: "custom", message: "Distinct endpoints must match the route filter's first and last airports" });
  }
});
export type CommercialRequestDescriptor = z.infer<typeof CommercialRequestDescriptorSchema>;

export const CommercialRejectionReasonSchema = z.enum([
  "unresolved_departure", "invalid_endpoint", "request_mismatch", "context_mismatch",
]);
export type CommercialRejectionReason = z.infer<typeof CommercialRejectionReasonSchema>;

export const CommercialResolutionDecisionSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("resolved"), descriptor: CommercialRequestDescriptorSchema }),
  z.strictObject({ outcome: z.literal("rejected"), jobId: CountSchema, reason: CommercialRejectionReasonSchema }),
]);
export type CommercialResolutionDecision = z.infer<typeof CommercialResolutionDecisionSchema>;

export const CommercialResolutionDiagnosticSchema = z.enum([
  "unresolved_departures_present", "invalid_endpoints_present", "request_mismatch", "context_mismatch",
]);
export type CommercialResolutionDiagnostic = z.infer<typeof CommercialResolutionDiagnosticSchema>;

const CommercialResolutionBaseSchema = z.strictObject({
  kind: z.literal("commercial_resolution"),
  requestId: RouteDiscoveryRequestSchema.shape.requestId,
  decisions: z.array(CommercialResolutionDecisionSchema),
  resolvedJobIds: z.array(CountSchema),
  diagnostics: z.array(CommercialResolutionDiagnosticSchema),
});

export const CommercialResolutionSchema = CommercialResolutionBaseSchema.superRefine((result, ctx) => {
  if (!CommercialResolutionBaseSchema.safeParse(result).success) return;
  const resolvedFromDecisions = result.decisions
    .filter(d => d.outcome === "resolved")
    .map(d => d.descriptor.jobId);
  if (JSON.stringify(result.resolvedJobIds) !== JSON.stringify(resolvedFromDecisions)) {
    ctx.addIssue({ code: "custom", message: "resolvedJobIds must be exactly the resolved decisions' jobIds in order" });
  }
});
export type CommercialResolution = z.infer<typeof CommercialResolutionSchema>;

export function resolveCommercialRequests(
  rawPlan: VerificationPlan,
  rawAdmissibility: ExecutionAdmissibility,
  rawTrustedContext: TrustedExecutionContext,
): CommercialResolution {
  // Strict parsing validates and independently clones all three untrusted inputs.
  const plan = VerificationPlanSchema.parse(rawPlan);
  const admissibility = ExecutionAdmissibilitySchema.parse(rawAdmissibility);
  const trustedContext = TrustedExecutionContextSchema.parse(rawTrustedContext);

  const decisions: CommercialResolutionDecision[] = [];
  const resolvedJobIds: number[] = [];
  const diagnostics: CommercialResolutionDiagnostic[] = [];
  const contextMatches = admissibility.trustedContextDigest === trustedContextDigest(trustedContext);
  const reject = (jobId: number, reason: CommercialRejectionReason, diagnostic: CommercialResolutionDiagnostic) => {
    decisions.push({ outcome: "rejected", jobId, reason });
    if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
  };

  for (const jobId of admissibility.admissibleJobIds) {
    const job = plan.jobs[jobId];
    // Jobs absent from either the plan or the admissible selection do no work.
    if (!job) continue;
    if (plan.requestId !== trustedContext.requestId || admissibility.requestId !== trustedContext.requestId) {
      reject(jobId, "request_mismatch", "request_mismatch");
      continue;
    }
    if (!contextMatches) {
      reject(jobId, "context_mismatch", "context_mismatch");
      continue;
    }
    if (job.requestIntent.departure.kind === "after_verified_arrival" || trustedContext.departure.kind === "unspecified") {
      reject(jobId, "unresolved_departure", "unresolved_departures_present");
      continue;
    }
    if (JSON.stringify(job.requestIntent.departure.intent) !== JSON.stringify(trustedContext.departure) ||
      JSON.stringify(job.requestIntent.passengers) !== JSON.stringify(trustedContext.passengers)) {
      reject(jobId, "context_mismatch", "context_mismatch");
      continue;
    }

    // Malformed/non-airport paths already fail plan parsing; also reject equal endpoints.
    const origin = AirportCodeSchema.safeParse(job.requestIntent.airports[0]);
    const destination = AirportCodeSchema.safeParse(job.requestIntent.airports.at(-1));
    if (!origin.success || !destination.success || origin.data === destination.data) {
      reject(jobId, "invalid_endpoint", "invalid_endpoints_present");
      continue;
    }
    decisions.push({
      outcome: "resolved",
      descriptor: {
        origin: origin.data,
        destination: destination.data,
        routeFilter: [...job.requestIntent.airports],
        departure: trustedContext.departure,
        passengers: trustedContext.passengers,
        jobId,
      },
    });
    resolvedJobIds.push(jobId);
  }

  return CommercialResolutionSchema.parse({
    kind: "commercial_resolution",
    // Retain the active request identity; this is not a provider-call/replay key.
    requestId: trustedContext.requestId,
    decisions,
    resolvedJobIds,
    diagnostics,
  });
}
