import {
  ConnectionPolicySchema, DependentDepartureFactSchema, VerifiedPrefixArrivalFactSchema,
  type ConnectionPolicy, type DependentDepartureFact, type VerifiedPrefixArrivalFact,
} from "@flightbrain/composer";

// Entirely synthetic topology, timestamps, and policy values.
// These fixtures make no claims about any real airport, carrier, schedule, or MCT rule.

export function verifiedArrival(change: Partial<VerifiedPrefixArrivalFact> = {}): VerifiedPrefixArrivalFact {
  return VerifiedPrefixArrivalFactSchema.parse({
    candidateIndex: 0,
    precedingLegIndex: 0,
    arrivalAirport: "NRT",
    arrivalAt: "2026-11-15T10:00:00Z",
    evidenceLevel: "scheduled",
    provenance: null,
    ...change,
  });
}

export function dependentDeparture(change: Partial<DependentDepartureFact> = {}): DependentDepartureFact {
  return DependentDepartureFactSchema.parse({
    candidateIndex: 0,
    legIndex: 1,
    departureAirport: "NRT",
    earliestDepartureAt: "2026-11-15T12:00:00Z",
    evidenceLevel: "scheduled",
    ...change,
  });
}

export function connectionPolicy(change: Partial<ConnectionPolicy> = {}): ConnectionPolicy {
  return ConnectionPolicySchema.parse({
    minConnectionMinutes: 60,
    allowAirportChange: false,
    airportChangeTransferMinutes: null,
    rolloverReference: { kind: "utc_instant" },
    ...change,
  });
}

export function airportChangePolicy(transferMinutes = 45): ConnectionPolicy {
  return ConnectionPolicySchema.parse({
    minConnectionMinutes: 60,
    allowAirportChange: true,
    airportChangeTransferMinutes: transferMinutes,
    rolloverReference: { kind: "utc_instant" },
  });
}
