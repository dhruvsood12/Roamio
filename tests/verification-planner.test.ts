import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RouteCandidateSchema, RouteDiscoveryResultSchema, type RouteCandidate, type RouteDiscoveryRequest,
} from "@flightbrain/domain";
import { planVerificationJobs, VerificationPlanSchema, VerificationRequestIntentSchema, type VerificationPlanningPolicy, type VerificationRequestIntent } from "@flightbrain/composer";
import { verificationIntentKey } from "../packages/composer/src/contracts";
import { airportLocation, discoveryEvidence, discoveryLeg, discoveryRequest, discoveryResult, flightCandidate, scheduledCandidate } from "./fixtures/discovery";

// Synthetic canonical topology and policies only; no genuine source/service claims.
const policy = (change: Partial<VerificationPlanningPolicy> = {}): VerificationPlanningPolicy => ({
  asOf: "2026-09-21T10:00:00Z", maxCandidateAgeMs: 60_000, maxCandidates: 10, maxLegsPerCandidate: 8, maxJobs: 100, ...change,
});
function candidate(airports: string[], id = "candidate-a", sourceId = "synthetic-source"): RouteCandidate {
  return RouteCandidateSchema.parse({
    ...flightCandidate(sourceId), id,
    legs: airports.slice(0, -1).map((origin, order) => ({
      ...discoveryLeg(order), origin: airportLocation(origin), destination: airportLocation(airports[order + 1]),
    })),
    evidence: airports.slice(1).map((_, index) => discoveryEvidence(index, sourceId)),
  });
}
function examples() {
  return [candidate(["DEL", "SFO"], "a"), candidate(["DEL", "NRT", "LAX", "SFO"], "b"),
    candidate(["DEL", "DOH", "SFO"], "c"), candidate(["DEL", "NRT", "SFO"], "d")];
}
function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
}
const plan = (candidates = examples(), change: Partial<VerificationPlanningPolicy> = {}, request = discoveryRequest()) =>
  planVerificationJobs(request, candidates, policy(change));

describe("bounded canonical verification-job planning", () => {
  it("plans all contiguous spans of the four example routes without building commercial objects", () => {
    const result = plan();
    expect(result.jobs).toHaveLength(12);
    expect(result.jobs.flatMap(job => job.sourceBindings)).toHaveLength(13);
    expect(result.jobs.slice(0, 4).map(job => job.requestIntent.airports)).toEqual([
      ["DEL", "SFO"], ["DEL", "NRT", "LAX", "SFO"], ["DEL", "DOH", "SFO"], ["DEL", "NRT", "SFO"],
    ]);
    expect(result.jobs.filter(job => job.sourceBindings.some(b => b.candidateIndex === 1)).map(job => job.requestIntent.airports)).toEqual([
      ["DEL", "NRT", "LAX", "SFO"], ["DEL", "NRT", "LAX"], ["DEL", "NRT"],
      ["NRT", "LAX", "SFO"], ["NRT", "LAX"], ["LAX", "SFO"],
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.unexaminedCandidateCount).toBe(0);
    expect(VerificationPlanSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    for (const field of ["offers", "trips", "payment", "scheduleFingerprint", "price", "status"]) expect(result).not.toHaveProperty(field);
  });

  it.each([0, 1, 4, 5, 12, 13, 100])("caps unique intents at %i and exposes omitted intents", maxJobs => {
    const result = plan(undefined, { maxJobs });
    expect(result.jobs).toHaveLength(Math.min(maxJobs, 12));
    expect(result.diagnostics).toEqual(maxJobs < 12 ? ["job_limit"] : []);
    expect(result.jobs.map(job => job.id)).toEqual(result.jobs.map((_, index) => index));
    expect(result.decisions).toHaveLength(4);
  });

  it("gives each candidate its whole-route job before any candidate's subroute jobs", () => {
    expect(plan(undefined, { maxJobs: 4 }).jobs.map(job => job.sourceBindings[0].candidateIndex)).toEqual([0, 1, 2, 3]);
  });

  it.each([0, 1, 3, 4, 10])("caps examined candidates at %i", maxCandidates => {
    const result = plan(undefined, { maxCandidates });
    expect(result.decisions).toHaveLength(Math.min(maxCandidates, 4));
    expect(result.unexaminedCandidateCount).toBe(Math.max(4 - maxCandidates, 0));
    expect(result.diagnostics).toEqual(maxCandidates < 4 ? ["candidate_limit"] : []);
  });

  it("does not inspect a candidate beyond the examination budget", () => {
    const candidates = [examples()[0], { get legs() { throw new Error("unexamined"); } } as unknown as RouteCandidate];
    expect(plan(candidates, { maxCandidates: 1 }).jobs).toHaveLength(1);
  });

  it("bounds work for long routes before schema refinements", () => {
    const raw = { legs: Array(33).fill(null), get evidence() { throw new Error("over budget"); } } as unknown as RouteCandidate;
    const result = plan([raw], { maxLegsPerCandidate: 32 });
    expect(result.decisions).toEqual([{ status: "skipped", candidateIndex: 0, reason: "leg_limit" }]);
    expect(result.jobs).toEqual([]);
  });

  it("supports zero leg budget and empty input without inventing coverage", () => {
    expect(plan(examples(), { maxLegsPerCandidate: 0 }).decisions.every(d => d.status === "skipped" && d.reason === "leg_limit")).toBe(true);
    expect(plan([])).toMatchObject({ inputCandidateCount: 0, unexaminedCandidateCount: 0, jobs: [], decisions: [], diagnostics: [] });
  });

  it("reports candidate and job limits independently", () => {
    expect(plan(undefined, { maxCandidates: 2, maxJobs: 1 }).diagnostics).toEqual(["candidate_limit", "job_limit"]);
  });

  it("is deterministic and preserves separate occurrences even when source/native IDs repeat", () => {
    const a = examples()[1], b = structuredClone(a), c = candidate(["DEL", "NRT", "LAX", "SFO"], a.id, "another-source");
    const result = plan([a, b, c]);
    expect(plan([a, b, c])).toEqual(result);
    expect(result.decisions).toHaveLength(3);
    expect(result.jobs).toHaveLength(12);
    expect(result.jobs.flatMap(job => job.sourceBindings)).toHaveLength(18);
    expect(result.jobs[0].sourceBindings.map(binding => binding.candidateIndex)).toEqual([0, 1, 2]);
  });

  it.each(["success", "partial", "timeout", "error"] as const)("accepts canonical candidates preserved in %s discovery results", status => {
    const result = RouteDiscoveryResultSchema.parse({ ...discoveryResult(), status });
    expect(plan(result.candidates).jobs).toHaveLength(6);
    // A plan says nothing about the source's enumeration/completion state.
    expect(plan(result.candidates)).not.toHaveProperty("sourceStatus");
  });

  it("plans the same topology for independent sources and heuristic hints", () => {
    const external = examples()[1], heuristic = candidate(["DEL", "NRT", "LAX", "SFO"], "hint", "synthetic-heuristic");
    heuristic.source.kind = "heuristic";
    expect(plan([heuristic]).jobs).toEqual(plan([external]).jobs);
    expect(plan([heuristic]).decisions[0]).toMatchObject({ status: "eligible", candidate: heuristic });
  });
});

describe("eligibility and observation handling", () => {
  it.each([
    ["request_mismatch", (c: RouteCandidate) => { c.requestId = "another-request"; }],
    ["unsupported_movement", (c: RouteCandidate) => { c.legs[0].mode = "rail"; }],
    ["unsupported_movement", (c: RouteCandidate) => { c.legs[0].origin = { kind: "address", address: "SYNTHETIC-PRIVATE", countryCode: null }; }],
    ["disconnected_route", (c: RouteCandidate) => { c.legs[1].origin = airportLocation("HND"); }],
    ["cyclic_route", (c: RouteCandidate) => { c.legs[1].destination = airportLocation("DEL"); c.legs[2].origin = airportLocation("DEL"); }],
    ["endpoint_mismatch", (c: RouteCandidate) => { c.legs[0].origin = airportLocation("ARN"); }],
    ["future_candidate", (c: RouteCandidate) => { c.discoveredAt = "2026-09-21T10:00:00.001Z"; }],
    ["stale_candidate", (c: RouteCandidate) => { c.discoveredAt = "2026-09-21T09:58:59.999Z"; }],
    ["unusable_route_evidence", (c: RouteCandidate) => { c.evidence[0].expiresAt = "2026-09-21T10:00:00Z"; }],
    ["unusable_route_evidence", (c: RouteCandidate) => { c.evidence[0].observedAt = "2026-09-21T10:00:00.001Z"; }],
  ] as const)("reports %s without changing the source observation %#", (reason, change) => {
    const c = examples()[1]; change(c); RouteCandidateSchema.parse(c);
    const before = structuredClone(c); freezeDeep(c);
    const result = plan([c, examples()[0]]);
    expect(result.decisions[0]).toEqual({ status: "skipped", candidateIndex: 0, reason });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceBindings[0].candidateIndex).toBe(1);
    expect(c).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC-PRIVATE");
  });

  it("does not drop transfer legs to manufacture an all-flight route", () => {
    const c = examples()[1]; c.legs[1].role = "transfer";
    c.evidence.push({ ...discoveryEvidence(1), factType: "transfer" });
    expect(plan([c]).decisions[0]).toMatchObject({ reason: "unsupported_movement" });
  });

  it.each([null, {}, { raw: "SYNTHETIC-SECRET" }, { ...flightCandidate(), extra: "SYNTHETIC-SECRET" }])(
    "isolates malformed candidates with bounded diagnostics %#", raw => {
      const result = plan([raw as RouteCandidate, examples()[0]]);
      expect(result.decisions[0]).toEqual({ status: "skipped", candidateIndex: 0, reason: "invalid_candidate" });
      expect(result.jobs).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC-SECRET");
    },
  );

  it("requires evidence from the candidate's own source", () => {
    const c = examples()[0]; c.evidence[0].sourceId = "another-source";
    expect(plan([c]).decisions[0]).toMatchObject({ reason: "invalid_candidate" });
  });

  it("enforces discovery stop constraints without claiming commercial eligibility", () => {
    const request = discoveryRequest(); request.maxIntermediateStops = 0;
    const result = plan(examples(), {}, request);
    expect(result.jobs).toHaveLength(1);
    expect(result.decisions.slice(1).every(d => d.status === "skipped" && d.reason === "stop_limit")).toBe(true);
  });

  it.each([
    { kind: "address", address: "SYNTHETIC-PRIVATE", countryCode: null },
    { kind: "point", coordinates: { latitude: 59.1234567, longitude: 18.7654321 } },
    { kind: "metro_area", name: "Synthetic Metro", countryCode: null, reference: null },
  ] as const)("does not resolve or expose private/unresolved request locations %#", origin => {
    const request = discoveryRequest(); request.origin = origin;
    const result = plan(undefined, {}, request);
    expect(result).toMatchObject({ jobs: [], decisions: [], unexaminedCandidateCount: 4, diagnostics: ["unsupported_request_location"] });
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC-PRIVATE|59\.1234567|18\.7654321|Synthetic Metro/);
  });

  it("does not override a request that excludes flight", () => {
    const request = discoveryRequest(); request.allowedModes = ["rail", "bus"];
    expect(plan(undefined, {}, request)).toMatchObject({ jobs: [], decisions: [], diagnostics: ["flight_mode_excluded"] });
  });

  it("uses millisecond instants for age boundaries and equivalent offsets", () => {
    const c = examples()[0]; c.discoveredAt = "2026-09-21T11:59:00+02:00";
    expect(plan([c]).jobs).toHaveLength(1);
    expect(plan([c], { maxCandidateAgeMs: 59_999 }).decisions[0]).toMatchObject({ reason: "stale_candidate" });
    expect(plan([examples()[0]], { maxCandidateAgeMs: 0 }).jobs).toHaveLength(1);
  });

  it("keeps unknown evidence times unknown and can use one still-valid route assertion", () => {
    const c = examples()[0]; c.evidence[0].expiresAt = policy().asOf;
    c.evidence.push({ ...discoveryEvidence(), expiresAt: "2026-09-21T12:00:00.001+02:00" });
    const result = plan([c]);
    expect(result.jobs[0].sourceBindings[0].routeEvidenceIndices).toEqual([1]);
    const snapshot = result.decisions[0];
    expect(snapshot.status === "eligible" && snapshot.candidate.evidence[1].observedAt).toBeNull();
    expect(snapshot.status === "eligible" && snapshot.candidate.evidence[0].expiresAt).toBe(policy().asOf);
  });
});

describe("departure intent, evidence binding and isolation", () => {
  it.each([
    { kind: "unspecified" }, { kind: "date", date: "2026-10-10" },
    { kind: "window", startAt: "2026-10-10T00:00:00Z", endAt: "2026-10-12T00:00:00Z" },
  ] as const)("retains explicit %s intent without inventing intermediate dates", departure => {
    const request = discoveryRequest(); request.departure = departure;
    const result = plan([examples()[1]], {}, request);
    for (const job of result.jobs) {
      const binding = job.sourceBindings[0];
      expect(job.requestIntent.departure).toEqual(binding.fromLegIndex === 0 ? { kind: "request_intent", intent: departure }
        : { kind: "after_verified_arrival", candidateIndex: 0, precedingLegIndex: binding.fromLegIndex - 1 });
      expect(job).not.toHaveProperty("duration");
    }
  });

  it("does not promote discovery schedules or estimates into commercial search dates or prices", () => {
    const c = scheduledCandidate(); c.legs[0].arrivalAt = null;
    c.evidence.find(fact => fact.factType === "estimated_price")!.expiresAt = "2026-09-20T00:00:00Z";
    const result = plan([c]);
    expect(result.jobs[0].requestIntent.departure).toEqual({ kind: "request_intent", intent: { kind: "unspecified" } });
    expect(result.jobs[0].sourceBindings[0].routeEvidenceIndices).toEqual([0]);
    expect(JSON.stringify(result.jobs)).not.toContain("3100000");
    expect(result.decisions[0]).toMatchObject({ status: "eligible", candidate: c });
  });

  it("retains source leg/evidence indexes for subroutes rather than retargeting them", () => {
    const c = examples()[1]; c.evidence.reverse();
    const result = plan([c]);
    const job = result.jobs.find(j => j.sourceBindings[0].fromLegIndex === 2)!;
    expect(job).toMatchObject({ requestIntent: { airports: ["LAX", "SFO"] },
      sourceBindings: [{ fromLegIndex: 2, toLegIndex: 2, routeEvidenceIndices: [0] }] });
    expect(result.decisions[0]).toMatchObject({ status: "eligible", candidate: { evidence: c.evidence } });
  });

  it("accepts deeply frozen inputs and returns independent snapshots and jobs", () => {
    const request = discoveryRequest(), candidates = examples(), options = policy();
    const before = structuredClone({ request, candidates, options });
    freezeDeep(request); freezeDeep(candidates); freezeDeep(options);
    const result = planVerificationJobs(request, candidates, options);
    result.jobs[0].requestIntent.airports[0] = "ARN";
    const decision = result.decisions[0];
    if (decision.status === "eligible") decision.candidate.evidence[0].sourceReference = { kind: "rule", id: "changed" };
    expect({ request, candidates, options }).toEqual(before);
    expect(result.jobs[1].requestIntent.airports[0]).toBe("DEL");
  });

  it.each([
    (p: ReturnType<typeof plan>) => { p.jobs[0].requestIntent.airports[0] = "ARN"; },
    (p: ReturnType<typeof plan>) => { p.jobs[0].sourceBindings[0].candidateIndex = 99; },
    (p: ReturnType<typeof plan>) => { p.jobs[0].id = 99; },
    (p: ReturnType<typeof plan>) => { p.jobs[0].sourceBindings[0].toLegIndex = 99; },
    (p: ReturnType<typeof plan>) => { p.jobs[0].sourceBindings[0].routeEvidenceIndices = [2]; },
    (p: ReturnType<typeof plan>) => { p.jobs[0].requestIntent.departure = { kind: "after_verified_arrival", candidateIndex: 0, precedingLegIndex: 0 }; },
    (p: ReturnType<typeof plan>) => { p.jobs.at(-1)!.requestIntent.departure = { kind: "after_verified_arrival", candidateIndex: 0, precedingLegIndex: 99 }; },
    (p: ReturnType<typeof plan>) => { p.jobs.push({ ...p.jobs[0], id: p.jobs.length }); },
    (p: ReturnType<typeof plan>) => { p.unexaminedCandidateCount++; },
    (p: ReturnType<typeof plan>) => { p.policy.maxJobs = 0; },
  ])("rejects a corrupted plan at the result boundary %#", mutate => {
    const result = plan([examples()[1]]); mutate(result);
    expect(VerificationPlanSchema.safeParse(result).success).toBe(false);
  });

  it("imports only canonical domain contracts, local planner code and schema validation", () => {
    const directory = new URL("../packages/composer/src/", import.meta.url);
    for (const file of readdirSync(directory)) {
      const text = readFileSync(new URL(file, directory), "utf8");
      const imports = [...text.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)].map(match => match[1]);
      expect(imports.every(name => ["@flightbrain/domain", "./contracts", "zod"].includes(name))).toBe(true);
      expect(text).not.toMatch(/Rome2Rio|rome2rio|fetch\s*\(/);
    }
  });
});

describe("planning policy validation", () => {
  it.each([
    { maxJobs: -1 }, { maxJobs: 1.5 }, { maxJobs: 10_001 }, { maxJobs: NaN }, { maxJobs: Infinity },
    { maxCandidates: -1 }, { maxCandidates: 1_001 }, { maxLegsPerCandidate: -1 }, { maxLegsPerCandidate: 33 },
    { maxCandidateAgeMs: -1 }, { maxCandidateAgeMs: Number.MAX_SAFE_INTEGER + 1 },
    { asOf: "invalid" }, { asOf: "2026-09-21T10:00:00-00:00" }, { extra: true },
  ])("rejects invalid or implicit policy values %j", change => {
    expect(() => planVerificationJobs(discoveryRequest(), examples(), { ...policy(), ...change })).toThrow();
  });

  it("requires explicit policy fields and a valid request", () => {
    expect(() => planVerificationJobs(discoveryRequest(), examples(), {} as VerificationPlanningPolicy)).toThrow();
    expect(() => planVerificationJobs({ ...discoveryRequest(), requestId: "" }, examples(), policy())).toThrow();
    expect(() => planVerificationJobs(discoveryRequest(), null as unknown as RouteCandidate[], policy())).toThrow();
    expect(() => planVerificationJobs({ ...discoveryRequest(), extra: true } as RouteDiscoveryRequest, examples(), policy())).toThrow();
  });
});

describe("exact source spans at the exported result boundary", () => {
  function singleSpan(start: number, end: number) {
    const result = plan([candidate(["DEL", "NRT", "LAX", "SEA", "SFO"])]);
    result.jobs = [result.jobs.find(job => job.sourceBindings[0].fromLegIndex === start &&
      job.sourceBindings[0].toLegIndex === end)!];
    result.jobs[0].id = 0;
    result.diagnostics = ["job_limit"];
    expect(VerificationPlanSchema.safeParse(result).success).toBe(true);
    return result;
  }

  const mutations = [[0, 3], [0, 2], [1, 3], [1, 2], [1, 1]].flatMap(([start, end]) =>
    Array.from({ length: end - start + 1 }, (_, i) => i + start).flatMap(legIndex =>
      (["origin", "destination"] as const).map(endpoint => ({ start, end, legIndex, endpoint }))));
  it.each(mutations)("rejects changed $endpoint of leg $legIndex in span $start..$end", ({ start, end, legIndex, endpoint }) => {
    const result = singleSpan(start, end), decision = result.decisions[0];
    if (decision.status !== "eligible") throw new Error("Expected eligible fixture");
    const originalEvidence = structuredClone(decision.candidate.evidence);
    decision.candidate.legs[legIndex][endpoint] = airportLocation("HND");
    // Discovery may contain the gap; the plan must not bind old work to it.
    expect(RouteCandidateSchema.safeParse(decision.candidate).success).toBe(true);
    const before = structuredClone(result); freezeDeep(result);
    expect(VerificationPlanSchema.safeParse(result).success).toBe(false);
    expect(result).toEqual(before);
    expect(decision.candidate.evidence).toEqual(originalEvidence);
  });

  it.each([
    ["HND", "LAX"], ["NRT", "SFO"],
  ])("rejects a job %s–%s bound to source NRT–LAX", (origin, destination) => {
    const result = singleSpan(1, 1);
    result.jobs[0].requestIntent.airports = [origin, destination];
    expect(VerificationPlanSchema.safeParse(result).success).toBe(false);
  });

  it("rejects a changed interior path even when source connectivity and outer endpoints survive", () => {
    const result = singleSpan(0, 3), decision = result.decisions[0];
    if (decision.status !== "eligible") throw new Error("Expected eligible fixture");
    decision.candidate.legs[0].destination = airportLocation("HND");
    decision.candidate.legs[1].origin = airportLocation("HND");
    expect(RouteCandidateSchema.safeParse(decision.candidate).success).toBe(true);
    expect(VerificationPlanSchema.safeParse(result).success).toBe(false);
  });

  it.each([false, true])("rejects source leg reordering (renumbered=%s)", renumber => {
    const result = singleSpan(0, 3), decision = result.decisions[0];
    if (decision.status !== "eligible") throw new Error("Expected eligible fixture");
    const legs = decision.candidate.legs;
    [legs[1], legs[2]] = [legs[2], legs[1]];
    if (renumber) legs.forEach((leg, index) => { leg.order = index; });
    expect(VerificationPlanSchema.safeParse(result).success).toBe(false);
  });

  it.each([{ fromLegIndex: 0 }, { toLegIndex: 3 }, { fromLegIndex: 2, toLegIndex: 1 }])(
    "rejects changed span indexes %j", change => {
      const result = singleSpan(1, 2);
      Object.assign(result.jobs[0].sourceBindings[0], change);
      expect(VerificationPlanSchema.safeParse(result).success).toBe(false);
    },
  );
});

describe("exact intent grouping and provider-job budgets", () => {
  it("retains every original source and evidence index when exact intents share work", () => {
    const first = examples()[1], second = candidate(["DEL", "NRT", "LAX", "SFO"], first.id, "another-source");
    second.evidence.reverse();
    const request = discoveryRequest(); request.departure = { kind: "date", date: "2026-11-10" }; request.passengers = { count: 2 };
    const before = structuredClone([first, second]); freezeDeep(first); freezeDeep(second);
    const result = plan([first, second], {}, request);
    const shared = result.jobs.find(job => JSON.stringify(job.requestIntent.airports) === '["DEL","NRT"]')!;
    expect(shared.requestIntent).toEqual({ airports: ["DEL", "NRT"],
      departure: { kind: "request_intent", intent: request.departure }, passengers: { count: 2 } });
    expect(shared.sourceBindings).toEqual([
      { candidateIndex: 0, fromLegIndex: 0, toLegIndex: 0, routeEvidenceIndices: [0] },
      { candidateIndex: 1, fromLegIndex: 0, toLegIndex: 0, routeEvidenceIndices: [2] },
    ]);
    expect(result.jobs).toHaveLength(9); // Three shared prefixes, six occurrence-dependent suffixes.
    expect(result.jobs.flatMap(job => job.sourceBindings)).toHaveLength(12);
    expect(result.decisions.map(d => d.status === "eligible" && d.candidate)).toEqual(before);
    freezeDeep(result);
    expect(VerificationPlanSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    const parsed = VerificationPlanSchema.parse(result);
    parsed.jobs.find(job => job.sourceBindings.length === 2)!.sourceBindings[1].routeEvidenceIndices.reverse();
    expect(result.decisions.map(d => d.status === "eligible" && d.candidate)).toEqual(before);
    expect([first, second]).toEqual(before);
  });

  it("charges one slot for equivalent occurrences and does not report false truncation", () => {
    const a = examples()[0], b = structuredClone(a);
    const result = plan([a, b], { maxJobs: 1 });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceBindings.map(binding => binding.candidateIndex)).toEqual([0, 1]);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects an in-range evidence index silently rebound within a second source occurrence", () => {
    const first = examples()[1], second = candidate(["DEL", "NRT", "LAX", "SFO"], "second", "another-source");
    second.evidence.reverse();
    const result = plan([first, second]);
    const shared = result.jobs.find(job => JSON.stringify(job.requestIntent.airports) === '["DEL","NRT"]')!;
    expect(shared.sourceBindings[1].routeEvidenceIndices).toEqual([2]);
    shared.sourceBindings[1].routeEvidenceIndices = [0]; // This is evidence for LAX–SFO in occurrence 1.
    expect(VerificationPlanSchema.safeParse(result).success).toBe(false);
  });

  it("retains late bindings after the budget is full and an intervening intent is omitted", () => {
    const result = plan([examples()[0], examples()[1], examples()[0]], { maxJobs: 1 });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceBindings.map(binding => binding.candidateIndex)).toEqual([0, 2]);
    expect(result.diagnostics).toEqual(["job_limit"]);
  });

  it("does not let repeated DEL–NRT work crowd LAX–SFO out of the eight-intent budget", () => {
    const request = discoveryRequest(); request.departure = { kind: "date", date: "2026-11-10" };
    const result = plan([examples()[1], examples()[3]], { maxJobs: 8 }, request);
    expect(result.jobs.map(job => job.requestIntent.airports)).toEqual([
      ["DEL", "NRT", "LAX", "SFO"], ["DEL", "NRT", "SFO"], ["DEL", "NRT", "LAX"],
      ["DEL", "NRT"], ["NRT", "LAX", "SFO"], ["NRT", "SFO"], ["NRT", "LAX"], ["LAX", "SFO"],
    ]);
    expect(result.jobs[3].sourceBindings.map(binding => binding.candidateIndex)).toEqual([1, 0]);
    expect(result.jobs.flatMap(job => job.sourceBindings)).toHaveLength(9);
    expect(result.diagnostics).toEqual([]);
    const truncated = plan([examples()[1], examples()[3]], { maxJobs: 7 }, request);
    expect(truncated.jobs).toEqual(result.jobs.slice(0, 7));
    expect(truncated.diagnostics).toEqual(["job_limit"]);
  });

  it("keeps identical suffix paths separate when their unresolved prefix occurrences differ", () => {
    const result = plan([examples()[1], candidate(["DEL", "DOH", "LAX", "SFO"])]);
    const suffixes = result.jobs.filter(job => JSON.stringify(job.requestIntent.airports) === '["LAX","SFO"]');
    expect(suffixes).toHaveLength(2);
    expect(suffixes.map(job => job.requestIntent.departure)).toEqual([
      { kind: "after_verified_arrival", candidateIndex: 0, precedingLegIndex: 1 },
      { kind: "after_verified_arrival", candidateIndex: 1, precedingLegIndex: 1 },
    ]);
    suffixes[0].sourceBindings.push(suffixes[1].sourceBindings[0]);
    result.jobs = result.jobs.filter(job => job !== suffixes[1]);
    result.jobs.forEach((job, i) => { job.id = i; });
    expect(VerificationPlanSchema.safeParse(result).success).toBe(false);
  });

  it("keeps materially different paths with the same outer endpoints separate", () => {
    const result = plan([examples()[1], examples()[2]], { maxJobs: 2 });
    expect(result.jobs.map(job => job.requestIntent.airports)).toEqual([
      ["DEL", "NRT", "LAX", "SFO"], ["DEL", "DOH", "SFO"],
    ]);
    expect(result.jobs.every(job => job.sourceBindings.length === 1)).toBe(true);
  });

  it("groups stably by first span encounter and preserves deterministic binding order", () => {
    const result = plan();
    expect(plan()).toEqual(result);
    const shared = result.jobs.find(job => job.sourceBindings.length > 1)!;
    expect(shared.requestIntent.airports).toEqual(["DEL", "NRT"]);
    expect(shared.sourceBindings.map(binding => binding.candidateIndex)).toEqual([3, 1]);
    const reordered = [examples()[3], examples()[1], examples()[0], examples()[2]];
    expect(plan(reordered)).toEqual(plan(reordered));
    expect(plan(reordered).jobs.slice(0, 4).map(job => job.requestIntent.airports)).toEqual([
      ["DEL", "NRT", "SFO"], ["DEL", "NRT", "LAX", "SFO"], ["DEL", "SFO"], ["DEL", "DOH", "SFO"],
    ]);
  });

  const intent = (): VerificationRequestIntent => ({ airports: ["DEL", "NRT"],
    departure: { kind: "request_intent", intent: { kind: "date", date: "2026-11-10" } }, passengers: null });
  it("canonicalizes object-key order without changing source inputs", () => {
    const first = intent();
    const reordered = { passengers: null, departure: { intent: { date: "2026-11-10", kind: "date" }, kind: "request_intent" }, airports: ["DEL", "NRT"] };
    const before = JSON.stringify(reordered); freezeDeep(reordered);
    expect(verificationIntentKey(VerificationRequestIntentSchema.parse(reordered))).toBe(verificationIntentKey(first));
    expect(JSON.stringify(reordered)).toBe(before);
  });

  it.each([
    (i: VerificationRequestIntent) => { i.departure = { kind: "request_intent", intent: { kind: "date", date: "2026-11-11" } }; },
    (i: VerificationRequestIntent) => { i.departure = { kind: "request_intent", intent: { kind: "unspecified" } }; },
    (i: VerificationRequestIntent) => { i.departure = { kind: "request_intent", intent: { kind: "window", startAt: "2026-11-10T00:00:00Z", endAt: "2026-11-11T00:00:00Z" } }; },
    (i: VerificationRequestIntent) => { i.departure = { kind: "after_verified_arrival", candidateIndex: 0, precedingLegIndex: 0 }; },
    (i: VerificationRequestIntent) => { i.airports = ["DEL", "DOH", "NRT"]; },
    (i: VerificationRequestIntent) => { i.passengers = { count: 1 }; },
  ])("never groups a non-equivalent canonical intent %#", mutate => {
    const other = intent(); mutate(other);
    expect(verificationIntentKey(other)).not.toBe(verificationIntentKey(intent()));
  });

  it("includes every dependency index and the exact passenger count in equivalence", () => {
    const first = { ...intent(), departure: { kind: "after_verified_arrival" as const, candidateIndex: 0, precedingLegIndex: 0 } };
    expect(verificationIntentKey({ ...first, departure: { ...first.departure, candidateIndex: 1 } })).not.toBe(verificationIntentKey(first));
    expect(verificationIntentKey({ ...first, departure: { ...first.departure, precedingLegIndex: 1 } })).not.toBe(verificationIntentKey(first));
    expect(verificationIntentKey({ ...intent(), passengers: { count: 2 } })).not.toBe(verificationIntentKey({ ...intent(), passengers: { count: 1 } }));
  });

  it.each(["startAt", "endAt"] as const)("retains the exact departure-window %s in equivalence", field => {
    const window = { kind: "window" as const, startAt: "2026-11-10T00:00:00Z", endAt: "2026-11-11T00:00:00Z" };
    const original: VerificationRequestIntent = { ...intent(), departure: { kind: "request_intent", intent: window } };
    const changed: VerificationRequestIntent = { ...intent(), departure: { kind: "request_intent", intent: {
      ...window, [field]: field === "startAt" ? "2026-11-10T01:00:00Z" : "2026-11-11T01:00:00Z",
    } } };
    expect(verificationIntentKey(changed)).not.toBe(verificationIntentKey(original));
  });

  it("rejects split equivalent jobs but keeps distinct known dates structurally separate", () => {
    const result = plan([examples()[0], examples()[0]]);
    const original = result.jobs[0];
    original.requestIntent.departure = { kind: "request_intent", intent: { kind: "date", date: "2026-11-10" } };
    result.jobs.push({ id: 1, requestIntent: structuredClone(original.requestIntent), sourceBindings: [original.sourceBindings.pop()!] });
    expect(VerificationPlanSchema.safeParse(result).success).toBe(false);
    result.jobs[1].requestIntent.departure = { kind: "request_intent", intent: { kind: "date", date: "2026-11-11" } };
    expect(VerificationPlanSchema.parse(result).jobs).toHaveLength(2);
    // Only the future trusted execution gate can compare dates with the active request.
  });

  it.each([
    (p: ReturnType<typeof plan>) => { p.jobs[0].sourceBindings = []; },
    (p: ReturnType<typeof plan>) => { p.jobs[0].sourceBindings.push(structuredClone(p.jobs[0].sourceBindings[0])); },
    (p: ReturnType<typeof plan>) => { p.jobs[0].sourceBindings[1].routeEvidenceIndices = []; },
    (p: ReturnType<typeof plan>) => { p.jobs[0].sourceBindings[1].candidateIndex = 20; },
    (p: ReturnType<typeof plan>) => { Object.assign(p.jobs[0].requestIntent, { providerMetadata: { private: "SYNTHETIC-SECRET" } }); },
    (p: ReturnType<typeof plan>) => { Object.assign(p.jobs[0].sourceBindings[0], { raw: "SYNTHETIC-SECRET" }); },
  ])("rejects corrupt grouped bindings and metadata escape hatches %#", mutate => {
    const result = plan([examples()[0], examples()[0]]); mutate(result);
    expect(VerificationPlanSchema.safeParse(result).success).toBe(false);
  });
});
