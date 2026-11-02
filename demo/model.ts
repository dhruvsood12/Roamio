import {
  addMoney, createTripOption, FlightOfferSchema, moneyFromDecimalString, RouteCandidateSchema,
  summarizePayments, TripOptionSchema, type Money, type RouteCandidate,
} from "@flightbrain/domain";
import { planVerificationJobs, type VerificationPlanningPolicy } from "@flightbrain/composer";
import { groupOffersByItinerary, itineraryFingerprint } from "@flightbrain/orchestrator";
import { cityLocation, discoveryRequest, multimodalCandidate } from "../tests/fixtures/discovery";
import { verificationExamples } from "../tests/fixtures/verification";
import { splitPlan, syntheticOffer, tripSegments } from "../tests/fixtures/trips";

export const SCENARIOS = { routes: "DEL → SFO · four route ideas", unknown: "Unknown departure dates",
  multimodal: "Stockholm → Copenhagen → Tokyo", boundaries: "Malformed, stale & unsupported" } as const;
export type Scenario = keyof typeof SCENARIOS;
export const BUDGETS = {
  generous: { label: "Generous", maxCandidates: 10, maxLegsPerCandidate: 8, maxJobs: 100 },
  normal: { label: "Normal", maxCandidates: 4, maxLegsPerCandidate: 3, maxJobs: 8 },
  constrained: { label: "Constrained", maxCandidates: 2, maxLegsPerCandidate: 2, maxJobs: 2 },
} as const;
export type Budget = keyof typeof BUDGETS;

export function demoScenario(scenario: Scenario) {
  const request = discoveryRequest();
  if (scenario !== "unknown") request.departure = { kind: "date", date: "2026-10-10" };
  let candidates: unknown[] = verificationExamples();
  if (scenario === "multimodal") {
    request.origin = cityLocation("Stockholm", "SE"); request.destination = cityLocation("Tokyo", "JP");
    candidates = [multimodalCandidate()];
  } else if (scenario === "boundaries") {
    const stale = verificationExamples()[0]; stale.id = "stale-example"; stale.discoveredAt = "2026-09-20T10:00:00Z";
    candidates = [verificationExamples()[0], stale, multimodalCandidate(), { kind: "route_candidate" }];
  }
  return { request, candidates };
}

export function plannerDemo(scenario: Scenario, budget: Budget) {
  const { request, candidates } = demoScenario(scenario);
  const { label: _label, ...limits } = BUDGETS[budget];
  const policy: VerificationPlanningPolicy = {
    asOf: "2026-09-21T10:00:00Z", maxCandidateAgeMs: 60_000, ...limits,
  };
  // The malformed scenario intentionally exercises the planner's existing input boundary.
  const result = planVerificationJobs(request, candidates as RouteCandidate[], policy);
  // Same candidate/leg admission, with ample job budget: counts come from real outputs.
  const beforeJobLimit = planVerificationJobs(request, candidates as RouteCandidate[], { ...policy, maxJobs: 10_000 });
  return {
    scenario, budget, request, policy, result,
    candidates: candidates.map(raw => { const parsed = RouteCandidateSchema.safeParse(raw); return parsed.success ? parsed.data : null; }),
    occurrenceSpans: beforeJobLimit.jobs.reduce((n, job) => n + job.sourceBindings.length, 0),
    uniqueIntents: beforeJobLimit.jobs.length,
    deferredIntents: beforeJobLimit.jobs.length - result.jobs.length,
    shared: beforeJobLimit.jobs.filter(job => job.sourceBindings.length > 1),
  };
}
export type PlannerDemo = ReturnType<typeof plannerDemo>;

export function budgetRegressionDemo() {
  const examples = verificationExamples(), request = discoveryRequest();
  request.departure = { kind: "date", date: "2026-11-10" };
  return planVerificationJobs(request, [examples[1], examples[3]], {
    asOf: "2026-09-21T10:00:00Z", maxCandidateAgeMs: 60_000, maxCandidates: 2, maxLegsPerCandidate: 3, maxJobs: 8,
  });
}

export function coreContractsDemo() {
  const segment = { ...tripSegments()[0], marketingCarrier: "BA", marketingFlightNumber: "123",
    operatingCarrier: "AA", operatingFlightNumber: "456" };
  const first = syntheticOffer([segment], "synthetic-a");
  first.totalPrice = moneyFromDecimalString("581.00", "USD");
  const second = syntheticOffer([{ ...segment, marketingCarrier: "AA", marketingFlightNumber: "456" }], "synthetic-b");
  second.totalPrice = moneyFromDecimalString("563.00", "USD");
  const unknown = syntheticOffer([{ ...segment, operatingFlightNumber: null }], "synthetic-unknown");
  const offers = [first, second, unknown].map(offer => FlightOfferSchema.parse(offer));
  const a = moneyFromDecimalString("410.00", "USD"), b = moneyFromDecimalString("5.60", "USD");
  const euro = moneyFromDecimalString("90.00", "EUR");
  let mixedRejected = false;
  try { addMoney(a, euro); } catch (error) { if (!(error instanceof RangeError)) throw error; mixedRejected = true; }
  const tripPlan = splitPlan();
  tripPlan.sourceOffers[0].totalPrice = a;
  tripPlan.bookingComponents[0].payment = { kind: "cash", amount: a };
  tripPlan.bookingComponents[1].payment = { kind: "award", program: { id: "synthetic-program" }, points: "55000", taxesAndFees: [b] };
  tripPlan.sourceOffers[2].totalPrice = euro;
  tripPlan.bookingComponents[2].payment = { kind: "cash", amount: euro };
  return {
    offers: offers.map(offer => ({ offer, fingerprint: itineraryFingerprint(offer) })),
    groups: groupOffersByItinerary(offers),
    money: { a, b, total: addMoney(a, b), mixedRejected, separate: summarizePayments([{ kind: "cash", amount: a }, { kind: "cash", amount: euro }]) },
    trip: TripOptionSchema.parse(createTripOption(tripPlan)),
  };
}

// Presentation only: keep integer digits exact instead of coercing Money to Number.
export function displayMoney(money: Money): string {
  const digits = money.amountMinor.padStart(money.exponent + 1, "0");
  return `${money.currency} ${money.exponent ? `${digits.slice(0, -money.exponent)}.${digits.slice(-money.exponent)}` : digits}`;
}

export const MILESTONE_STATES = ["IMPLEMENTED", "SIMULATED WITH CANONICAL FIXTURES", "BLOCKED", "NOT YET BUILT"] as const;
export function milestoneRows(markdown: string) {
  const section = markdown.split("<!-- demo-status:start -->")[1]?.split("<!-- demo-status:end -->")[0];
  if (!section) throw new Error("CURRENT_STATE.md is missing its demo status table");
  const rows = section.split("\n").filter(line => line.startsWith("| ")).slice(2).map(line => {
    const [name, status, detail] = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (!name || !detail || !MILESTONE_STATES.includes(status as typeof MILESTONE_STATES[number])) throw new Error("Invalid current-state status row");
    return { name, status, detail };
  });
  if (!rows.length) throw new Error("Empty current-state status table");
  return rows;
}
