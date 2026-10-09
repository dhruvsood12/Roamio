import {
  RouteCandidateSchema, RouteDiscoveryRequestSchema,
  type RouteCandidate, type RouteDiscoveryRequest,
} from "@flightbrain/domain";
import {
  airportPath, usableRouteEvidence, verificationIntentKey, VerificationPlanSchema, VerificationPlanningPolicySchema,
  type CandidatePlanningReason, type VerificationJob, type VerificationPlan, type VerificationPlanningPolicy,
  type VerificationRequestIntent, type VerificationSourceBinding,
} from "./contracts";

export {
  VerificationJobSchema, VerificationPlanSchema, VerificationPlanningPolicySchema,
  VerificationRequestIntentSchema, VerificationSourceBindingSchema,
  type VerificationJob, type VerificationPlan, type VerificationPlanningPolicy,
  type VerificationRequestIntent, type VerificationSourceBinding,
} from "./contracts";

function ineligible(candidate: RouteCandidate, request: RouteDiscoveryRequest, policy: VerificationPlanningPolicy): CandidatePlanningReason | null {
  if (candidate.requestId !== request.requestId) return "request_mismatch";
  if (candidate.legs.some(leg => leg.mode !== "flight" || leg.role !== "travel" ||
    leg.origin.kind !== "airport" || leg.destination.kind !== "airport")) return "unsupported_movement";
  const path = airportPath(candidate);
  if (!path) return "disconnected_route";
  if (new Set(path).size !== path.length) return "cyclic_route";
  if (request.origin.kind !== "airport" || request.destination.kind !== "airport" ||
    path[0] !== request.origin.iataCode || path.at(-1) !== request.destination.iataCode) return "endpoint_mismatch";
  if (request.maxIntermediateStops !== null && candidate.legs.length - 1 > request.maxIntermediateStops) return "stop_limit";
  const asOf = Date.parse(policy.asOf), discoveredAt = Date.parse(candidate.discoveredAt);
  if (discoveredAt > asOf) return "future_candidate";
  if (asOf - discoveredAt > policy.maxCandidateAgeMs) return "stale_candidate";
  if (candidate.legs.some((_, legIndex) => !candidate.evidence.some(fact =>
    usableRouteEvidence(fact, asOf) && fact.target.kind === "leg" && fact.target.legIndex === legIndex))) return "unusable_route_evidence";
  return null;
}

// Whole route first, then longer contiguous spans, with leftmost ties first.
function* spans(length: number): Generator<[number, number]> {
  for (let size = length; size > 0; size--) {
    for (let start = 0; start + size <= length; start++) yield [start, start + size - 1];
  }
}

// Pure, finite-snapshot planning. No provider execution, commercial facts or trip construction.
export function planVerificationJobs(
  rawRequest: RouteDiscoveryRequest, candidates: readonly RouteCandidate[], rawPolicy: VerificationPlanningPolicy,
): VerificationPlan {
  const request = RouteDiscoveryRequestSchema.parse(rawRequest);
  const policy = VerificationPlanningPolicySchema.parse(rawPolicy);
  if (!Array.isArray(candidates)) throw new TypeError("Expected a candidate array");
  const plan: VerificationPlan = {
    kind: "verification_plan", requestId: request.requestId, policy, inputCandidateCount: candidates.length,
    unexaminedCandidateCount: candidates.length, decisions: [], jobs: [], diagnostics: [],
  };
  if (request.origin.kind !== "airport" || request.destination.kind !== "airport") plan.diagnostics.push("unsupported_request_location");
  if (request.allowedModes !== null && !request.allowedModes.includes("flight")) plan.diagnostics.push("flight_mode_excluded");
  if (plan.diagnostics.length) return VerificationPlanSchema.parse(plan);

  const eligible: { candidateIndex: number; candidate: RouteCandidate; spans: Generator<[number, number]> }[] = [];
  for (let i = 0; i < Math.min(candidates.length, policy.maxCandidates); i++) {
    const raw = candidates[i];
    let reason: CandidatePlanningReason | null = null;
    // Enforce the route-length budget before walking its schema/evidence refinements.
    if (raw && Array.isArray(raw.legs) && raw.legs.length > policy.maxLegsPerCandidate) reason = "leg_limit";
    const parsed = reason ? null : RouteCandidateSchema.safeParse(raw);
    if (!reason && !parsed?.success) reason = "invalid_candidate";
    if (parsed?.success) reason = ineligible(parsed.data, request, policy);
    if (reason || !parsed?.success) {
      plan.decisions.push({ status: "skipped", candidateIndex: i, reason: reason ?? "invalid_candidate" });
    } else {
      plan.decisions.push({ status: "eligible", candidateIndex: i, candidate: parsed.data });
      eligible.push({ candidateIndex: i, candidate: parsed.data, spans: spans(parsed.data.legs.length) });
    }
  }
  plan.unexaminedCandidateCount -= plan.decisions.length;
  if (plan.unexaminedCandidateCount > 0) plan.diagnostics.push("candidate_limit");

  let remainingSpans = eligible.reduce((count, { candidate }) => count + candidate.legs.length * (candidate.legs.length + 1) / 2, 0);
  const admitted = new Map<string, VerificationJob>();
  let omittedIntent = false;
  // Stable round-robin order determines first admission. Continue after the job
  // budget fills to retain every binding for admitted intents. Candidate/leg caps
  // bound enumeration; the map holds at most maxJobs intents, in insertion order.
  while (remainingSpans > 0) {
    for (const item of eligible) {
      const next = item.spans.next();
      if (next.done) continue;
      remainingSpans--;
      const [fromLegIndex, toLegIndex] = next.value;
      const requestIntent: VerificationRequestIntent = {
        airports: airportPath(item.candidate, fromLegIndex, toLegIndex)!,
        departure: fromLegIndex === 0 ? { kind: "request_intent", intent: request.departure }
          : { kind: "after_verified_arrival", candidateIndex: item.candidateIndex, precedingLegIndex: fromLegIndex - 1 },
        passengers: request.passengers,
      };
      const key = verificationIntentKey(requestIntent);
      const existing = admitted.get(key);
      if (!existing && plan.jobs.length === policy.maxJobs) { omittedIntent = true; continue; }
      const binding: VerificationSourceBinding = {
        candidateIndex: item.candidateIndex, fromLegIndex, toLegIndex,
        routeEvidenceIndices: item.candidate.evidence.flatMap((fact, i) =>
          usableRouteEvidence(fact, Date.parse(policy.asOf)) && fact.target.kind === "leg" &&
          fact.target.legIndex >= fromLegIndex && fact.target.legIndex <= toLegIndex ? [i] : []),
      };
      if (existing) existing.sourceBindings.push(binding);
      else {
        const job = { id: plan.jobs.length, requestIntent, sourceBindings: [binding] };
        admitted.set(key, job);
        plan.jobs.push(job);
      }
    }
  }
  if (omittedIntent) plan.diagnostics.push("job_limit");
  return VerificationPlanSchema.parse(plan);
}
