import { RouteCandidateSchema, type RouteCandidate } from "@flightbrain/domain";
import { airportLocation, discoveryEvidence, discoveryLeg, flightCandidate } from "./discovery";

// Shared synthetic C002.3c topology: used by regression tests and the developer demo.
export function verificationCandidate(airports: string[], id = "candidate-a", sourceId = "synthetic-source"): RouteCandidate {
  return RouteCandidateSchema.parse({
    ...flightCandidate(sourceId), id,
    legs: airports.slice(0, -1).map((origin, order) => ({
      ...discoveryLeg(order), origin: airportLocation(origin), destination: airportLocation(airports[order + 1]),
    })),
    evidence: airports.slice(1).map((_, index) => discoveryEvidence(index, sourceId)),
  });
}
export function verificationExamples() {
  return [verificationCandidate(["DEL", "SFO"], "a"), verificationCandidate(["DEL", "NRT", "LAX", "SFO"], "b"),
    verificationCandidate(["DEL", "DOH", "SFO"], "c"), verificationCandidate(["DEL", "NRT", "SFO"], "d")];
}
