import {
  DiscoverySourceDefinitionSchema, RouteCandidateSchema, RouteDiscoveryRequestSchema, RouteDiscoveryResultSchema,
  type LocationRef, type RouteCandidate, type RouteCandidateLeg, type RouteEvidence,
} from "@flightbrain/domain";

// Entirely synthetic topology, schedules, prices, capabilities and review references.
// These fixtures make no claims about any real source or service.
export const airportLocation = (iataCode: string): LocationRef => ({ kind: "airport", iataCode });
export const cityLocation = (name: string, countryCode: string): LocationRef => ({ kind: "city", name, countryCode, reference: null });
export function discoveryRequest() {
  return RouteDiscoveryRequestSchema.parse({
    requestId: "request-1", origin: airportLocation("DEL"), destination: airportLocation("SFO"),
    departure: { kind: "unspecified" }, allowedModes: null, maxIntermediateStops: null, passengers: null,
  });
}
export function discoveryDefinition(id = "synthetic-source") {
  return DiscoverySourceDefinitionSchema.parse({
    id, name: "Synthetic Discovery Source", accessMethod: "api",
    capabilities: { modes: ["flight", "rail", "walk"], multimodal: true, dateFiltering: true,
      schedules: true, estimatedPrices: true, realtime: null, geography: { kind: "unknown" } },
  });
}
export function discoveryLeg(order = 0): RouteCandidateLeg {
  return {
    order, origin: airportLocation("DEL"), destination: airportLocation("SFO"), mode: "flight", role: "travel",
    operator: null, serviceRef: null, scheduleState: "unknown", departureAt: null, arrivalAt: null,
    estimatedDurationMinutes: null, estimatedPrice: null,
  };
}
export function discoveryEvidence(legIndex: number | null = 0, sourceId = "synthetic-source"): Extract<RouteEvidence, { factType: "route_exists" }> {
  return {
    factType: "route_exists", level: "hint", sourceId,
    target: legIndex === null ? { kind: "candidate" } : { kind: "leg", legIndex },
    observedAt: null, expiresAt: null, sourceReference: null,
  };
}
export function flightCandidate(sourceId = "synthetic-source"): RouteCandidate {
  const airports = ["DEL", "NRT", "LAX", "SFO"];
  return RouteCandidateSchema.parse({
    kind: "route_candidate", id: "occurrence-1", requestId: "request-1",
    source: { sourceId, kind: "external", externalRouteId: null }, discoveredAt: "2026-09-21T10:00:00Z",
    legs: airports.slice(0, -1).map((origin, index) => ({ ...discoveryLeg(index), origin: airportLocation(origin), destination: airportLocation(airports[index + 1]) })),
    evidence: [0, 1, 2].map(index => discoveryEvidence(index, sourceId)),
    estimatedDurationMinutes: null, estimatedPrice: null,
  });
}
export function multimodalCandidate(): RouteCandidate {
  const candidate = flightCandidate();
  candidate.legs = [
    { ...discoveryLeg(), origin: cityLocation("Stockholm", "SE"), destination: cityLocation("Copenhagen", "DK"), mode: "rail" },
    { ...discoveryLeg(1), origin: cityLocation("Copenhagen", "DK"), destination: cityLocation("Tokyo", "JP") },
  ];
  candidate.evidence = [discoveryEvidence(0), discoveryEvidence(1)];
  return RouteCandidateSchema.parse(candidate);
}
export function scheduledCandidate(): RouteCandidate {
  const candidate = flightCandidate();
  candidate.legs = [{ ...discoveryLeg(), scheduleState: "scheduled", departureAt: "2026-10-10T00:00:00Z", arrivalAt: "2026-10-10T08:00:00Z" }];
  candidate.evidence = [
    { ...discoveryEvidence(), level: "scheduled" },
    { ...discoveryEvidence(), factType: "schedule", level: "scheduled" },
  ];
  candidate.estimatedPrice = { kind: "estimate", amount: { amountMinor: "3100000", currency: "INR", exponent: 2 }, basis: "unknown" };
  candidate.evidence.push({ ...discoveryEvidence(null), factType: "estimated_price", level: "estimated" });
  return RouteCandidateSchema.parse(candidate);
}
export function discoveryResult(candidates = [flightCandidate()]) {
  return RouteDiscoveryResultSchema.parse({
    kind: "route_discovery_result", requestId: "request-1", sourceId: "synthetic-source", candidates,
    startedAt: "2026-09-21T10:00:00Z", finishedAt: "2026-09-21T10:00:01Z", status: "success", diagnostics: [],
  });
}
