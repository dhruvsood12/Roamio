import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planVerificationJobs } from "@flightbrain/composer";
import type { RouteCandidate } from "@flightbrain/domain";
import { BUDGETS, budgetRegressionDemo, coreContractsDemo, demoScenario, milestoneRows, plannerDemo, SCENARIOS } from "../demo/model";
import { renderDemo } from "../demo/view";

const state = readFileSync(new URL("../docs/CURRENT_STATE.md", import.meta.url), "utf8");
afterEach(() => vi.unstubAllGlobals());

describe("local developer demo", () => {
  it("renders counts and shared evidence from the actual canonical planner output", () => {
    const model = plannerDemo("routes", "generous"), html = renderDemo(state, "routes", "generous");
    expect(model.occurrenceSpans).toBe(13); expect(model.uniqueIntents).toBe(12);
    expect(html).toContain(`data-testid="span-count">${model.occurrenceSpans}<`);
    expect(html).toContain(`data-testid="intent-count">${model.uniqueIntents}<`);
    const shared = model.shared[0];
    expect(shared.requestIntent.airports).toEqual(["DEL", "NRT"]);
    expect(shared.sourceBindings.map(binding => binding.candidateIndex)).toEqual([3, 1]);
    for (const binding of shared.sourceBindings) {
      expect(html).toContain(`Candidate ${binding.candidateIndex + 1} · occurrence`);
      expect(html).toContain(`Original legs ${binding.fromLegIndex}..${binding.toLegIndex} · evidence [${binding.routeEvidenceIndices.join(", ")}]`);
    }
  });

  it.each(Object.keys(BUDGETS) as (keyof typeof BUDGETS)[])("reruns the real planner for the %s preset", preset => {
    const model = plannerDemo("routes", preset), { request, candidates } = demoScenario("routes");
    expect(model.result).toEqual(planVerificationJobs(request, candidates as RouteCandidate[], model.policy));
    expect(renderDemo(state, "routes", preset)).toContain(`data-testid="job-count">${model.result.jobs.length}<`);
    expect(model.deferredIntents).toBe(model.uniqueIntents - model.result.jobs.length);
  });

  it("retains the budget-starvation regression through the real planner", () => {
    const result = budgetRegressionDemo();
    expect(result.jobs).toHaveLength(8);
    expect(result.jobs.flatMap(job => job.sourceBindings)).toHaveLength(9);
    expect(result.jobs.some(job => job.requestIntent.airports.join("/") === "LAX/SFO")).toBe(true);
  });

  it("keeps unknown dates and original dependency identities unresolved", () => {
    const model = plannerDemo("unknown", "generous");
    expect(model.result.jobs[0].requestIntent.departure).toEqual({ kind: "request_intent", intent: { kind: "unspecified" } });
    expect(model.result.jobs.some(job => job.requestIntent.departure.kind === "after_verified_arrival")).toBe(true);
    const html = renderDemo(state, "unknown", "generous");
    expect(html).toContain("Unresolved · request date unspecified");
    expect(html).toContain("Unresolved · after candidate");
  });

  it("keeps both multimodal movements and shows the canonical rejection", () => {
    const model = plannerDemo("multimodal", "generous"), html = renderDemo(state, "multimodal", "generous");
    expect(model.candidates[0]!.legs.map(leg => leg.mode)).toEqual(["rail", "flight"]);
    expect(model.result.jobs).toEqual([]);
    expect(model.result.diagnostics).toEqual(["unsupported_request_location"]);
    expect(html).toContain("Stockholm"); expect(html).toContain("Copenhagen"); expect(html).toContain("Tokyo");
    expect(html).toContain("unsupported_request_location");
  });

  it("reports malformed, stale and unsupported fixtures without leaking raw data", () => {
    const model = plannerDemo("boundaries", "generous");
    expect(model.result.decisions).toMatchObject([
      { status: "eligible" }, { reason: "stale_candidate" }, { reason: "unsupported_movement" }, { reason: "invalid_candidate" },
    ]);
    expect(model.candidates[3]).toBeNull();
    expect(renderDemo(state, "boundaries", "generous")).toContain("Its raw payload is withheld");
  });

  it("exercises identity, money and TripOption contracts independently of planner jobs", () => {
    const core = coreContractsDemo();
    expect(core.groups.map(group => group.offers.length)).toEqual([2, 1]);
    expect(core.offers[0].fingerprint).toBe(core.offers[1].fingerprint);
    expect(core.offers[2].fingerprint).toBeNull();
    expect(core.money.total).toEqual({ amountMinor: "41560", currency: "USD", exponent: 2 });
    expect(core.money.mixedRejected).toBe(true);
    expect(core.trip.bookingComponents.map(c => c.payment.kind)).toEqual(["cash", "award", "cash"]);
    expect(core.trip.payment.cashByCurrency).toEqual([
      { amountMinor: "9000", currency: "EUR", exponent: 2 }, { amountMinor: "41560", currency: "USD", exponent: 2 },
    ]);
    expect(core.trip.connections.every(c => c.protection === "self_transfer")).toBe(true);
  });

  it("renders every scenario offline with explicit synthetic and unavailable labels", () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected outbound request"); }); vi.stubGlobal("fetch", fetch);
    for (const scenario of Object.keys(SCENARIOS)) {
      const html = renderDemo(state, scenario, "generous");
      expect(html).toContain("SYNTHETIC CANONICAL DATA");
      expect(html).toContain("SYNTHETIC VERIFIED COMMERCIAL FIXTURES");
      expect(html).toContain("Provider execution — NOT YET BUILT");
      expect(html).toContain("No live flight prices");
      expect(html).not.toMatch(/<script|(?:src|href|action)="https?:\/\//);
      expect(html).not.toContain("providerMetadata");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads milestone statuses from CURRENT_STATE rather than a second roadmap", () => {
    const amended = state.replace("| Rome2Rio native mapping | BLOCKED |", "| Rome2Rio native mapping | NOT YET BUILT |");
    expect(milestoneRows(amended).find(row => row.name === "Rome2Rio native mapping")?.status).toBe("NOT YET BUILT");
    expect(renderDemo(amended, "routes", "generous")).toContain("Rome2Rio native mapping");
    expect(() => milestoneRows("missing table")).toThrow();
  });

  it("escapes document content and defaults unsupported query parameters safely", () => {
    const amended = state.replace("Canonical candidates, source facts and partial observations.", '<img src=x onerror="alert(1)">');
    const html = renderDemo(amended, "<script>", "__proto__");
    expect(html).toContain("&lt;img"); expect(html).not.toContain("<img src=x");
    expect(html).toContain('data-testid="span-count">13<');
  });

  it("keeps dependency direction toward canonical packages without source-specific clients", () => {
    const model = readFileSync(new URL("../demo/model.ts", import.meta.url), "utf8");
    expect(model).not.toMatch(/Rome2RioClient|Rome2RioDiscoverySource|rome2rio\//);
    for (const directory of ["domain", "composer", "discovery"]) {
      const path = new URL(`../packages/${directory}/src/`, import.meta.url);
      for (const file of readdirSync(path).filter(name => name.endsWith(".ts"))) {
        expect(readFileSync(new URL(file, path), "utf8")).not.toMatch(/from\s+["'][^"']*demo\//);
      }
    }
  });
});
