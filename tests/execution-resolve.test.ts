import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  CommercialDepartureSchema, CommercialRequestDescriptorSchema, CommercialResolutionSchema,
  ExecutionAdmissibilitySchema, VerificationPlanSchema,
  planVerificationJobs, resolveCommercialRequests, trustedContextDigest, validatePlanForExecution,
  type CommercialResolution, type TrustedExecutionContext,
} from "@flightbrain/composer";
import { discoveryRequest } from "./fixtures/discovery";
import { trustedExecutionContext } from "./fixtures/execution";
import { verificationCandidate as candidate, verificationExamples as examples } from "./fixtures/verification";

// Synthetic canonical topology only; no genuine source/service claims.
function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
}

function buildInputs(change: Partial<TrustedExecutionContext> = {}, candidateList = examples()) {
  const ctx = trustedExecutionContext({ departure: { kind: "date", date: "2026-11-15" }, passengers: { count: 2 }, ...change });
  const request = { ...discoveryRequest(), departure: ctx.departure, passengers: ctx.passengers };
  const plan = planVerificationJobs(request, candidateList, {
    asOf: "2026-09-21T10:00:00Z", maxCandidateAgeMs: 60_000,
    maxCandidates: 10, maxLegsPerCandidate: 8, maxJobs: 100,
  });
  return { plan, ctx, admissibility: validatePlanForExecution(plan, ctx) };
}

describe("commercial request resolution — happy path", () => {
  it("resolves admissible request_intent jobs in order with trusted date and passengers", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    const requestIntentJobs = plan.jobs.filter(j => j.requestIntent.departure.kind === "request_intent");

    expect(requestIntentJobs.length).toBeGreaterThan(0);
    expect(result.kind).toBe("commercial_resolution");
    expect(result.requestId).toBe(ctx.requestId);
    expect(result.decisions).toEqual(requestIntentJobs.map(job => ({
      outcome: "resolved",
      descriptor: {
        origin: job.requestIntent.airports[0], destination: job.requestIntent.airports.at(-1),
        routeFilter: job.requestIntent.airports, departure: ctx.departure, passengers: ctx.passengers, jobId: job.id,
      },
    })));
    expect(result.resolvedJobIds).toEqual(admissibility.admissibleJobIds);
    expect(result.diagnostics).toEqual([]);
  });

  it("preserves the entire route as a result filter without via-airport parameters", () => {
    const { plan, ctx, admissibility } = buildInputs({}, [candidate(["DEL", "NRT", "LAX", "SFO"])]);
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    expect(result.decisions[0]).toEqual({
      outcome: "resolved",
      descriptor: { origin: "DEL", destination: "SFO", routeFilter: ["DEL", "NRT", "LAX", "SFO"],
        departure: ctx.departure, passengers: ctx.passengers, jobId: 0 },
    });
    for (const decision of result.decisions) {
      if (decision.outcome === "resolved") {
        expect(Object.keys(decision.descriptor).sort()).toEqual(["departure", "destination", "jobId", "origin", "passengers", "routeFilter"]);
      }
    }
  });

  it("preserves a trusted departure window, including offsets and milliseconds", () => {
    const departure = { kind: "window" as const, startAt: "2026-11-15T23:30:00.123+05:30", endAt: "2026-11-17T01:00:00.456+05:30" };
    const { plan, ctx, admissibility } = buildInputs({ departure });
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    expect(result.decisions.length).toBeGreaterThan(0);
    for (const decision of result.decisions) {
      expect(decision.outcome).toBe("resolved");
      if (decision.outcome === "resolved") expect(decision.descriptor.departure).toEqual(departure);
    }
  });

  it("preserves unknown passengers as null", () => {
    const { plan, ctx, admissibility } = buildInputs({ passengers: null });
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    expect(result.decisions[0]).toMatchObject({ outcome: "resolved", descriptor: { passengers: null } });
  });

  it("skips after_verified_arrival and budget-rejected jobs entirely", () => {
    const { plan, ctx, admissibility } = buildInputs({
      budget: { maxProviderIntents: 2, alreadyConsumedIntents: 0, maxCandidateAgeMs: 300_000 },
    });
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    expect(admissibility.decisions.some(d => d.status === "rejected" && d.reason === "departure_unresolved")).toBe(true);
    expect(admissibility.decisions.some(d => d.status === "rejected" && d.reason === "budget_exhausted")).toBe(true);
    expect(result.resolvedJobIds).toEqual(admissibility.admissibleJobIds);
    expect(result.decisions).toHaveLength(admissibility.admissibleJobIds.length);
    for (const decision of admissibility.decisions.filter(d => d.status === "rejected")) {
      expect(result.resolvedJobIds).not.toContain(decision.jobId);
      expect(result.decisions).not.toContainEqual(expect.objectContaining({ jobId: decision.jobId }));
    }
  });

  it("skips jobs absent from admissibility", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const firstOnly = ExecutionAdmissibilitySchema.parse({
      ...admissibility, decisions: admissibility.decisions.slice(0, 1), admissibleJobIds: [0],
    });
    const result = resolveCommercialRequests(plan, firstOnly, ctx);
    expect(result.decisions).toHaveLength(1);
    expect(result.resolvedJobIds).toEqual([0]);
  });

  it("skips admissions whose jobs are absent from the plan", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const emptyPlan = VerificationPlanSchema.parse({ ...plan, jobs: [] });
    expect(resolveCommercialRequests(emptyPlan, admissibility, ctx)).toEqual({
      kind: "commercial_resolution", requestId: ctx.requestId, decisions: [], resolvedJobIds: [], diagnostics: [],
    });
  });

  it("JSON round-trip equality", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    expect(CommercialResolutionSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it("has no commercial facts or invented eligibility fields anywhere in the result", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    const assertNoCommercialFields = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      for (const field of ["price", "offers", "bookingUrl", "fare", "providerMetadata", "cabin", "market", "adultCount", "adults", "via", "viaAirports"]) {
        expect(value).not.toHaveProperty(field);
      }
      Object.values(value).forEach(assertNoCommercialFields);
    };
    assertNoCommercialFields(result);
  });

  it("is deterministic — two identical calls deep-equal", () => {
    const { plan, ctx, admissibility } = buildInputs();
    expect(resolveCommercialRequests(plan, admissibility, ctx)).toEqual(resolveCommercialRequests(plan, admissibility, ctx));
  });

  it("is pure — frozen inputs do not throw and remain unchanged", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const before = structuredClone({ plan, ctx, admissibility });
    freezeDeep(plan);
    freezeDeep(ctx);
    freezeDeep(admissibility);
    expect(() => resolveCommercialRequests(plan, admissibility, ctx)).not.toThrow();
    expect({ plan, ctx, admissibility }).toEqual(before);
  });

  it("returns independent clones of route, departure and passenger context", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const before = structuredClone({ plan, ctx, admissibility });
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    const decision = result.decisions[0];
    expect(decision.outcome).toBe("resolved");
    if (decision.outcome !== "resolved") throw new Error("Expected a resolved descriptor");
    decision.descriptor.routeFilter[0] = "LHR";
    if (decision.descriptor.departure.kind === "date") decision.descriptor.departure.date = "2026-12-01";
    if (decision.descriptor.passengers) decision.descriptor.passengers.count = 99;
    expect({ plan, ctx, admissibility }).toEqual(before);
    expect(resolveCommercialRequests(plan, admissibility, ctx)).not.toEqual(result);
  });
});

describe("commercial request resolution — failure cases", () => {
  it("rejects unspecified departures without inventing a date", () => {
    const { plan, ctx, admissibility } = buildInputs({ departure: { kind: "unspecified" } });
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    expect(admissibility.admissibleJobIds.length).toBeGreaterThan(0);
    expect(result.resolvedJobIds).toEqual([]);
    expect(result.decisions).toEqual(admissibility.admissibleJobIds.map(jobId => ({ outcome: "rejected", jobId, reason: "unresolved_departure" })));
    expect(result.diagnostics).toEqual(["unresolved_departures_present"]);
  });

  it("rejects an arrival-dependent job even if untrusted admissibility marks it admissible", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const job = plan.jobs.find(j => j.requestIntent.departure.kind === "after_verified_arrival");
    if (!job) throw new Error("Expected an arrival-dependent fixture job");
    const decisions = admissibility.decisions.map(d => d.jobId === job.id ? { status: "admissible" as const, jobId: d.jobId } : d);
    const forged = ExecutionAdmissibilitySchema.parse({
      ...admissibility, decisions, admissibleJobIds: decisions.filter(d => d.status === "admissible").map(d => d.jobId),
    });
    const result = resolveCommercialRequests(plan, forged, ctx);
    expect(result.decisions).toContainEqual({ outcome: "rejected", jobId: job.id, reason: "unresolved_departure" });
    expect(result.resolvedJobIds).not.toContain(job.id);
  });

  it("rejects equal origin/destination endpoints with a fixed reason", () => {
    const { plan, ctx } = buildInputs({}, [candidate(["DEL", "SFO"])]);
    // Structurally valid airport path with no distinct endpoints; entry validation
    // cannot prove that a supplied plan was produced by the planner.
    const decision = plan.decisions[0];
    if (decision.status !== "eligible") throw new Error("Expected an eligible fixture candidate");
    decision.candidate.legs[0].destination = { kind: "airport", iataCode: "DEL" };
    plan.jobs[0].requestIntent.airports = ["DEL", "DEL"];
    const admissibility = validatePlanForExecution(plan, ctx);
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    expect(result.decisions).toEqual([{ outcome: "rejected", jobId: 0, reason: "invalid_endpoint" }]);
    expect(result.resolvedJobIds).toEqual([]);
    expect(result.diagnostics).toEqual(["invalid_endpoints_present"]);
  });

  it("rejects admissions for a different active request", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const result = resolveCommercialRequests(plan, admissibility, { ...ctx, requestId: "different-request" });
    expect(result.resolvedJobIds).toEqual([]);
    expect(result.decisions).toEqual(admissibility.admissibleJobIds.map(jobId => ({ outcome: "rejected", jobId, reason: "request_mismatch" })));
    expect(result.diagnostics).toEqual(["request_mismatch"]);
  });

  it("rejects an admissibility requestId that differs from the plan and context", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const result = resolveCommercialRequests(plan, { ...admissibility, requestId: "different-request" }, ctx);
    expect(result.resolvedJobIds).toEqual([]);
    expect(result.decisions.every(d => d.outcome === "rejected" && d.reason === "request_mismatch")).toBe(true);
  });

  it("rejects admissions bound to a different trusted context", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const result = resolveCommercialRequests(plan, admissibility, { ...ctx, passengers: { count: 3 } });
    expect(result.resolvedJobIds).toEqual([]);
    expect(result.decisions).toEqual(admissibility.admissibleJobIds.map(jobId => ({ outcome: "rejected", jobId, reason: "context_mismatch" })));
    expect(result.diagnostics).toEqual(["context_mismatch"]);
  });

  it.each(["departure", "passengers"] as const)("rejects changed plan %s even with a matching context digest", field => {
    const { plan, ctx, admissibility } = buildInputs();
    const changedContext = trustedExecutionContext({ ...ctx,
      ...(field === "departure" ? { departure: { kind: "date", date: "2026-12-01" } } : { passengers: { count: 3 } }),
    });
    const forged = { ...admissibility, trustedContextDigest: trustedContextDigest(changedContext) };
    const result = resolveCommercialRequests(plan, forged, changedContext);
    expect(result.resolvedJobIds).toEqual([]);
    expect(result.decisions.every(d => d.outcome === "rejected" && d.reason === "context_mismatch")).toBe(true);
  });
});

describe("commercial request resolution — schema validation", () => {
  it.each(["del", "DE", "DELL", "D3L", "DEL\n", { kind: "city", name: "Delhi" }])("throws ZodError for malformed/non-airport endpoint %j", endpoint => {
    const { plan, ctx, admissibility } = buildInputs();
    const malformed = { ...plan, jobs: plan.jobs.map((job, index) => index === 0
      ? { ...job, requestIntent: { ...job.requestIntent, airports: [endpoint, "SFO"] } } : job) };
    expect(() => resolveCommercialRequests(malformed as never, admissibility, ctx)).toThrow(ZodError);
  });

  it.each([{}, null, { kind: "verification_plan", extra: true }])("throws ZodError on malformed plan %j", plan => {
    const { ctx, admissibility } = buildInputs();
    expect(() => resolveCommercialRequests(plan as never, admissibility, ctx)).toThrow(ZodError);
  });

  it.each([{}, null, { kind: "execution_admissibility", extra: true }])("throws ZodError on malformed admissibility %j", admissibility => {
    const { plan, ctx } = buildInputs();
    expect(() => resolveCommercialRequests(plan, admissibility as never, ctx)).toThrow(ZodError);
  });

  it.each([{}, null, { requestId: "request-1", extra: true }])("throws ZodError on malformed trusted context %j", ctx => {
    const { plan, admissibility } = buildInputs();
    expect(() => resolveCommercialRequests(plan, admissibility, ctx as never)).toThrow(ZodError);
  });

  it("rejects internally inconsistent admissibility at entry", () => {
    const { plan, ctx, admissibility } = buildInputs();
    expect(() => resolveCommercialRequests(plan, { ...admissibility, admissibleJobIds: [9999] }, ctx)).toThrow(ZodError);
  });

  it("rejects invalid trusted date/window/passenger values at entry", () => {
    const { plan, ctx, admissibility } = buildInputs();
    for (const change of [
      { departure: { kind: "date", date: "2026-02-30" } },
      { departure: { kind: "window", startAt: "2026-11-15T10:00:00Z", endAt: "2026-11-15T10:00:00Z" } },
      { passengers: { count: 0 } },
    ]) {
      expect(() => resolveCommercialRequests(plan, admissibility, { ...ctx, ...change } as never)).toThrow(ZodError);
    }
    expect(CommercialDepartureSchema.safeParse({ kind: "unspecified" }).success).toBe(false);
  });

  it.each(["missing", "extra", "reordered", "duplicate"])("superRefine rejects %s resolvedJobIds", corruption => {
    const { plan, ctx, admissibility } = buildInputs();
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    const corrupted = JSON.parse(JSON.stringify(result)) as CommercialResolution;
    expect(corrupted.resolvedJobIds.length).toBeGreaterThan(1);
    switch (corruption) {
      case "missing": corrupted.resolvedJobIds.pop(); break;
      case "extra": corrupted.resolvedJobIds.push(9999); break;
      case "reordered": corrupted.resolvedJobIds.reverse(); break;
      case "duplicate": corrupted.resolvedJobIds.push(corrupted.resolvedJobIds[0]); break;
    }
    expect(CommercialResolutionSchema.safeParse(corrupted).success).toBe(false);
  });

  it("superRefine rejects a resolved decision changed to rejected without updating resolvedJobIds", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    const corrupted = JSON.parse(JSON.stringify(result)) as CommercialResolution;
    corrupted.decisions[0] = { outcome: "rejected", jobId: corrupted.resolvedJobIds[0], reason: "unresolved_departure" };
    expect(CommercialResolutionSchema.safeParse(corrupted).success).toBe(false);
  });

  it("strict schemas reject extra commercial fields at every public object boundary", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    const decision = result.decisions[0];
    if (decision.outcome !== "resolved") throw new Error("Expected a resolved descriptor");
    expect(CommercialResolutionSchema.safeParse({ ...result, offers: [] }).success).toBe(false);
    expect(CommercialResolutionSchema.safeParse({ ...result, decisions: [{ ...decision, price: 123 }] }).success).toBe(false);
    for (const field of ["price", "offers", "bookingUrl", "fare", "providerMetadata", "cabin", "market", "adultCount"]) {
      expect(CommercialRequestDescriptorSchema.safeParse({ ...decision.descriptor, [field]: null }).success).toBe(false);
    }
  });

  it("descriptor schema rejects endpoints inconsistent with the route filter", () => {
    const { plan, ctx, admissibility } = buildInputs();
    const result = resolveCommercialRequests(plan, admissibility, ctx);
    const decision = result.decisions[0];
    if (decision.outcome !== "resolved") throw new Error("Expected a resolved descriptor");
    expect(CommercialRequestDescriptorSchema.safeParse({ ...decision.descriptor, origin: "LHR" }).success).toBe(false);
    expect(CommercialRequestDescriptorSchema.safeParse({ ...decision.descriptor, destination: "LHR" }).success).toBe(false);
  });
});
