import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  ConnectionFeasibilityDecisionSchema, ConnectionPolicySchema,
  DependentDepartureFactSchema, VerifiedPrefixArrivalFactSchema,
  evaluateConnectionFeasibility,
  type ConnectionFeasibilityDecision,
} from "@flightbrain/composer";
import {
  airportChangePolicy, connectionPolicy, dependentDeparture, verifiedArrival,
} from "./fixtures/feasibility";

// Synthetic topology only; no real airport, MCT, schedule or connection claims.

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
}

// ---------------------------------------------------------------------------
// Feasible — same-airport
// ---------------------------------------------------------------------------

describe("connection feasibility — feasible same-airport", () => {
  it("returns feasible with same_airport and meets_minimum_connection", () => {
    const arrival = verifiedArrival({ arrivalAirport: "NRT", arrivalAt: "2026-11-15T10:00:00Z" });
    const departure = dependentDeparture({ departureAirport: "NRT", earliestDepartureAt: "2026-11-15T12:00:00Z" });
    const policy = connectionPolicy({ minConnectionMinutes: 60 });
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("feasible");
    if (result.status !== "feasible") throw new Error("Expected feasible");
    expect(result.airportRelation).toBe("same_airport");
    expect(result.gapMinutes).toBe(120);
    expect(result.splitTicket).toBe(true);
    expect(result.reasons).toContain("same_airport");
    expect(result.reasons).toContain("meets_minimum_connection");
  });

  it("boundary: gap == min is FEASIBLE (inclusive)", () => {
    const arrival = verifiedArrival({ arrivalAt: "2026-11-15T10:00:00Z" });
    const departure = dependentDeparture({ earliestDepartureAt: "2026-11-15T11:00:00Z" });
    const policy = connectionPolicy({ minConnectionMinutes: 60 });
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("feasible");
  });

  it("boundary: gap == min - 1 is infeasible", () => {
    const arrival = verifiedArrival({ arrivalAt: "2026-11-15T10:00:00Z" });
    const departure = dependentDeparture({ earliestDepartureAt: "2026-11-15T10:59:00Z" });
    const policy = connectionPolicy({ minConnectionMinutes: 60 });
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") throw new Error("Expected infeasible");
    expect(result.reasons).toContain("below_minimum_connection");
    expect(result.gapMinutes).toBe(59);
  });

  it("boundary: gap == 0 minutes is infeasible when min > 0", () => {
    const arrival = verifiedArrival({ arrivalAt: "2026-11-15T10:00:00Z" });
    const departure = dependentDeparture({ earliestDepartureAt: "2026-11-15T10:00:00Z" });
    const policy = connectionPolicy({ minConnectionMinutes: 60 });
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("infeasible");
  });

  it("boundary: gap == 0 is FEASIBLE when minConnectionMinutes is 0", () => {
    const arrival = verifiedArrival({ arrivalAt: "2026-11-15T10:00:00Z" });
    const departure = dependentDeparture({ earliestDepartureAt: "2026-11-15T10:00:00Z" });
    const policy = connectionPolicy({ minConnectionMinutes: 0 });
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("feasible");
  });
});

// ---------------------------------------------------------------------------
// Feasible — airport change
// ---------------------------------------------------------------------------

describe("connection feasibility — feasible airport change", () => {
  it("returns feasible airport_change when gap >= min + transfer and allowed", () => {
    const arrival = verifiedArrival({ arrivalAirport: "NRT", arrivalAt: "2026-11-15T10:00:00Z" });
    const departure = dependentDeparture({ departureAirport: "HND", earliestDepartureAt: "2026-11-15T12:30:00Z" });
    const policy = airportChangePolicy(45); // min=60 + transfer=45 = 105 min required; gap=150 min
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("feasible");
    if (result.status !== "feasible") throw new Error("Expected feasible");
    expect(result.airportRelation).toBe("airport_change");
    expect(result.splitTicket).toBe(true);
    expect(result.reasons).toContain("airport_change_allowed");
    expect(result.reasons).toContain("meets_minimum_connection");
  });

  it("infeasible when airport change is not allowed, regardless of gap", () => {
    const arrival = verifiedArrival({ arrivalAirport: "NRT", arrivalAt: "2026-11-15T10:00:00Z" });
    const departure = dependentDeparture({ departureAirport: "HND", earliestDepartureAt: "2026-11-15T20:00:00Z" });
    const policy = connectionPolicy({ minConnectionMinutes: 60, allowAirportChange: false, airportChangeTransferMinutes: null });
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") throw new Error("Expected infeasible");
    expect(result.reasons).toContain("airport_change_disallowed");
    expect(result.gapMinutes).toBeNull();
  });

  it("infeasible when gap < min + transfer", () => {
    const arrival = verifiedArrival({ arrivalAirport: "NRT", arrivalAt: "2026-11-15T10:00:00Z" });
    const departure = dependentDeparture({ departureAirport: "HND", earliestDepartureAt: "2026-11-15T11:00:00Z" });
    const policy = airportChangePolicy(45); // need 105 min, have 60
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") throw new Error("Expected infeasible");
    expect(result.reasons).toContain("below_minimum_connection");
    expect(result.gapMinutes).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Infeasible — negative gap
// ---------------------------------------------------------------------------

describe("connection feasibility — negative gap", () => {
  it("returns infeasible with negative_gap when departure is before arrival", () => {
    const arrival = verifiedArrival({ arrivalAt: "2026-11-15T12:00:00Z" });
    const departure = dependentDeparture({ earliestDepartureAt: "2026-11-15T10:00:00Z" });
    const policy = connectionPolicy({ minConnectionMinutes: 60 });
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") throw new Error("Expected infeasible");
    expect(result.reasons).toContain("negative_gap");
    expect(result.gapMinutes).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown — various reasons
// ---------------------------------------------------------------------------

describe("connection feasibility — unknown decisions", () => {
  it("unknown when arrival and departure have mismatched candidateIndex", () => {
    const arrival = verifiedArrival({ candidateIndex: 0, precedingLegIndex: 0 });
    const departure = dependentDeparture({ candidateIndex: 1, legIndex: 1 });
    const result = evaluateConnectionFeasibility(arrival, departure, connectionPolicy());
    expect(result.status).toBe("unknown");
    expect(result.reasons).toContain("dependency_mismatch");
  });

  it("unknown when precedingLegIndex + 1 != legIndex", () => {
    const arrival = verifiedArrival({ candidateIndex: 0, precedingLegIndex: 0 });
    const departure = dependentDeparture({ candidateIndex: 0, legIndex: 2 }); // should be 1
    const result = evaluateConnectionFeasibility(arrival, departure, connectionPolicy());
    expect(result.status).toBe("unknown");
    expect(result.reasons).toContain("dependency_mismatch");
  });

  it("unknown when airport change is allowed but airportChangeTransferMinutes is null", () => {
    const arrival = verifiedArrival({ arrivalAirport: "NRT" });
    const departure = dependentDeparture({ departureAirport: "HND" });
    const policy = connectionPolicy({
      allowAirportChange: true,
      airportChangeTransferMinutes: null,
    });
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("unknown");
    expect(result.reasons).toContain("missing_transfer_time");
  });

  it("rejects estimated as evidenceLevel at schema parse time", () => {
    expect(() => VerifiedPrefixArrivalFactSchema.parse({
      candidateIndex: 0, precedingLegIndex: 0, arrivalAirport: "NRT",
      arrivalAt: "2026-11-15T10:00:00Z",
      evidenceLevel: "estimated", // only scheduled/observed allowed
      provenance: null,
    })).toThrow(ZodError);

    expect(() => DependentDepartureFactSchema.parse({
      candidateIndex: 0, legIndex: 1, departureAirport: "NRT",
      earliestDepartureAt: "2026-11-15T12:00:00Z",
      evidenceLevel: "estimated", // only scheduled/observed allowed
    })).toThrow(ZodError);
  });

  it("rejects hint as evidenceLevel at schema parse time", () => {
    expect(() => VerifiedPrefixArrivalFactSchema.parse({
      candidateIndex: 0, precedingLegIndex: 0, arrivalAirport: "NRT",
      arrivalAt: "2026-11-15T10:00:00Z",
      evidenceLevel: "hint",
      provenance: null,
    })).toThrow(ZodError);
  });
});

// ---------------------------------------------------------------------------
// Day rollover
// ---------------------------------------------------------------------------

describe("connection feasibility — day rollover", () => {
  it("reports dayRollover:true when departure crosses midnight UTC", () => {
    const arrival = verifiedArrival({ arrivalAt: "2026-11-15T23:00:00Z" });
    const departure = dependentDeparture({ earliestDepartureAt: "2026-11-16T02:00:00Z" });
    const policy = connectionPolicy({ minConnectionMinutes: 60 });
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("feasible");
    if (result.status !== "feasible") throw new Error("Expected feasible");
    expect(result.dayRollover).toBe(true);
    expect(result.reasons).toContain("day_rollover");
  });

  it("same verdict feasible with dayRollover:true vs same-day without rollover", () => {
    // Rollover case: crosses midnight, gap = 180 min
    const arrivalRollover = verifiedArrival({ arrivalAt: "2026-11-15T23:00:00Z" });
    const departureRollover = dependentDeparture({ earliestDepartureAt: "2026-11-16T02:00:00Z" });
    // Same-day case: no midnight cross, gap = 180 min
    const arrivalSameDay = verifiedArrival({ arrivalAt: "2026-11-15T10:00:00Z" });
    const departureSameDay = dependentDeparture({ earliestDepartureAt: "2026-11-15T13:00:00Z" });
    const policy = connectionPolicy({ minConnectionMinutes: 60 });
    const rolloverResult = evaluateConnectionFeasibility(arrivalRollover, departureRollover, policy);
    const sameDayResult = evaluateConnectionFeasibility(arrivalSameDay, departureSameDay, policy);
    // Both feasible — rollover doesn't change verdict
    expect(rolloverResult.status).toBe("feasible");
    expect(sameDayResult.status).toBe("feasible");
    if (rolloverResult.status !== "feasible" || sameDayResult.status !== "feasible") throw new Error("Both must be feasible");
    expect(rolloverResult.dayRollover).toBe(true);
    expect(sameDayResult.dayRollover).toBe(false);
  });

  it("reports no_day_rollover when same calendar day under UTC", () => {
    const arrival = verifiedArrival({ arrivalAt: "2026-11-15T10:00:00Z" });
    const departure = dependentDeparture({ earliestDepartureAt: "2026-11-15T12:00:00Z" });
    const policy = connectionPolicy({ minConnectionMinutes: 60 });
    const result = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(result.status).toBe("feasible");
    if (result.status !== "feasible") throw new Error("Expected feasible");
    expect(result.dayRollover).toBe(false);
    expect(result.reasons).toContain("no_day_rollover");
  });

  it("fixed_offset rolloverReference flips the rollover annotation without changing the verdict", () => {
    // Arrival 23:30Z, departure next-day 00:15Z. Gap = 45 min (feasible at minConnection 30).
    //   utc_instant:            Nov 15 -> Nov 16  => rollover TRUE
    //   fixed_offset_minutes -600 (-10h): 13:30 -> 14:15 local, both Nov 15 => rollover FALSE
    // The offset genuinely flips the annotation; the VERDICT must be identical in both.
    const arrival = verifiedArrival({ arrivalAt: "2026-11-15T23:30:00Z" });
    const departure = dependentDeparture({ earliestDepartureAt: "2026-11-16T00:15:00Z" });
    const utcPolicy = connectionPolicy({
      minConnectionMinutes: 30,
      rolloverReference: { kind: "utc_instant" },
    });
    const fixedPolicy = connectionPolicy({
      minConnectionMinutes: 30,
      rolloverReference: { kind: "fixed_offset_minutes", offsetMinutes: -600 },
    });
    const utcResult = evaluateConnectionFeasibility(arrival, departure, utcPolicy);
    const fixedResult = evaluateConnectionFeasibility(arrival, departure, fixedPolicy);
    expect(utcResult.status).toBe("feasible");
    expect(fixedResult.status).toBe("feasible");
    if (utcResult.status !== "feasible" || fixedResult.status !== "feasible") throw new Error("Both must be feasible");
    // The offset flips the rollover annotation...
    expect(utcResult.dayRollover).toBe(true);
    expect(fixedResult.dayRollover).toBe(false);
    expect(utcResult.reasons).toContain("day_rollover");
    expect(fixedResult.reasons).toContain("no_day_rollover");
    // ...but the verdict (status, gap, relation, split-ticket) is identical.
    expect(utcResult.gapMinutes).toBe(45);
    expect(fixedResult.gapMinutes).toBe(45);
    expect(utcResult.airportRelation).toBe(fixedResult.airportRelation);
    expect(utcResult.splitTicket).toBe(fixedResult.splitTicket);
  });
});

// ---------------------------------------------------------------------------
// Split-ticket labeling (AGENTS.md rule 9)
// ---------------------------------------------------------------------------

describe("connection feasibility — split-ticket labeling", () => {
  it("every feasible decision has splitTicket === true", () => {
    const result = evaluateConnectionFeasibility(
      verifiedArrival({ arrivalAt: "2026-11-15T10:00:00Z" }),
      dependentDeparture({ earliestDepartureAt: "2026-11-15T12:00:00Z" }),
      connectionPolicy({ minConnectionMinutes: 60 }),
    );
    expect(result.status).toBe("feasible");
    if (result.status !== "feasible") throw new Error("Expected feasible");
    expect(result.splitTicket).toBe(true);
  });

  it("the word 'protected' never appears in any decision", () => {
    const scenarios: ConnectionFeasibilityDecision[] = [
      // feasible
      evaluateConnectionFeasibility(
        verifiedArrival({ arrivalAt: "2026-11-15T10:00:00Z" }),
        dependentDeparture({ earliestDepartureAt: "2026-11-15T12:00:00Z" }),
        connectionPolicy({ minConnectionMinutes: 60 }),
      ),
      // infeasible
      evaluateConnectionFeasibility(
        verifiedArrival({ arrivalAt: "2026-11-15T12:00:00Z" }),
        dependentDeparture({ earliestDepartureAt: "2026-11-15T10:00:00Z" }),
        connectionPolicy({ minConnectionMinutes: 60 }),
      ),
      // unknown
      evaluateConnectionFeasibility(
        verifiedArrival({ candidateIndex: 0, precedingLegIndex: 0 }),
        dependentDeparture({ candidateIndex: 1, legIndex: 1 }),
        connectionPolicy(),
      ),
    ];
    for (const scenario of scenarios) {
      const serialized = JSON.stringify(scenario);
      expect(serialized).not.toContain("protected");
    }
  });

  it("infeasible and unknown decisions do NOT have splitTicket field", () => {
    const infeasible = evaluateConnectionFeasibility(
      verifiedArrival({ arrivalAt: "2026-11-15T12:00:00Z" }),
      dependentDeparture({ earliestDepartureAt: "2026-11-15T10:00:00Z" }),
      connectionPolicy({ minConnectionMinutes: 60 }),
    );
    expect(infeasible.status).toBe("infeasible");
    expect(infeasible).not.toHaveProperty("splitTicket");

    const unknown = evaluateConnectionFeasibility(
      verifiedArrival({ candidateIndex: 0, precedingLegIndex: 0 }),
      dependentDeparture({ candidateIndex: 1, legIndex: 1 }),
      connectionPolicy(),
    );
    expect(unknown.status).toBe("unknown");
    expect(unknown).not.toHaveProperty("splitTicket");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("connection feasibility — determinism", () => {
  it("two identical calls produce deeply equal results", () => {
    const arrival = verifiedArrival();
    const departure = dependentDeparture();
    const policy = connectionPolicy();
    const r1 = evaluateConnectionFeasibility(arrival, departure, policy);
    const r2 = evaluateConnectionFeasibility(arrival, departure, policy);
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("connection feasibility — purity", () => {
  it("frozen inputs do not throw and remain unchanged after call", () => {
    const arrival = verifiedArrival();
    const departure = dependentDeparture();
    const policy = connectionPolicy();
    const before = structuredClone({ arrival, departure, policy });
    freezeDeep(arrival);
    freezeDeep(departure);
    freezeDeep(policy);
    expect(() => evaluateConnectionFeasibility(arrival, departure, policy)).not.toThrow();
    expect({ arrival, departure, policy }).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// JSON round-trip
// ---------------------------------------------------------------------------

describe("connection feasibility — JSON round-trip", () => {
  it("feasible decision round-trips through schema", () => {
    const result = evaluateConnectionFeasibility(
      verifiedArrival(),
      dependentDeparture(),
      connectionPolicy({ minConnectionMinutes: 60 }),
    );
    expect(result.status).toBe("feasible");
    const parsed = ConnectionFeasibilityDecisionSchema.parse(JSON.parse(JSON.stringify(result)));
    expect(parsed).toEqual(result);
  });

  it("infeasible decision round-trips through schema", () => {
    const result = evaluateConnectionFeasibility(
      verifiedArrival({ arrivalAt: "2026-11-15T12:00:00Z" }),
      dependentDeparture({ earliestDepartureAt: "2026-11-15T10:00:00Z" }),
      connectionPolicy({ minConnectionMinutes: 60 }),
    );
    expect(result.status).toBe("infeasible");
    const parsed = ConnectionFeasibilityDecisionSchema.parse(JSON.parse(JSON.stringify(result)));
    expect(parsed).toEqual(result);
  });

  it("unknown decision round-trips through schema", () => {
    const result = evaluateConnectionFeasibility(
      verifiedArrival({ candidateIndex: 0, precedingLegIndex: 0 }),
      dependentDeparture({ candidateIndex: 1, legIndex: 1 }),
      connectionPolicy(),
    );
    expect(result.status).toBe("unknown");
    const parsed = ConnectionFeasibilityDecisionSchema.parse(JSON.parse(JSON.stringify(result)));
    expect(parsed).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// superRefine: rejects contradictory status/reason combinations
// ---------------------------------------------------------------------------

describe("connection feasibility — superRefine rejects contradictory decisions", () => {
  it("rejects a feasible decision with an unknown-category reason", () => {
    expect(ConnectionFeasibilityDecisionSchema.safeParse({
      status: "feasible",
      gapMinutes: 120,
      airportRelation: "same_airport",
      splitTicket: true,
      dayRollover: false,
      reasons: ["meets_minimum_connection", "same_airport", "no_day_rollover", "dependency_mismatch"],
    }).success).toBe(false);
  });

  it("rejects an infeasible decision with unknown-category reasons", () => {
    expect(ConnectionFeasibilityDecisionSchema.safeParse({
      status: "infeasible",
      gapMinutes: null,
      reasons: ["dependency_mismatch"],
    }).success).toBe(false);
  });

  it("rejects an unknown decision with feasible-category reasons", () => {
    expect(ConnectionFeasibilityDecisionSchema.safeParse({
      status: "unknown",
      reasons: ["meets_minimum_connection"],
    }).success).toBe(false);
  });

  it("rejects reasons in wrong order", () => {
    // Correct order would be: same_airport, meets_minimum_connection, no_day_rollover
    expect(ConnectionFeasibilityDecisionSchema.safeParse({
      status: "feasible",
      gapMinutes: 120,
      airportRelation: "same_airport",
      splitTicket: true,
      dayRollover: false,
      reasons: ["no_day_rollover", "same_airport", "meets_minimum_connection"], // wrong order
    }).success).toBe(false);
  });

  it("accepts a valid feasible decision", () => {
    expect(ConnectionFeasibilityDecisionSchema.safeParse({
      status: "feasible",
      gapMinutes: 120,
      airportRelation: "same_airport",
      splitTicket: true,
      dayRollover: false,
      reasons: ["meets_minimum_connection", "same_airport", "no_day_rollover"],
    }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("connection feasibility — schema validation", () => {
  it("rejects malformed arrival airport code", () => {
    expect(() => evaluateConnectionFeasibility(
      { ...verifiedArrival(), arrivalAirport: "nrt" as never },
      dependentDeparture(),
      connectionPolicy(),
    )).toThrow(ZodError);
  });

  it("rejects malformed departure airport code", () => {
    expect(() => evaluateConnectionFeasibility(
      verifiedArrival(),
      { ...dependentDeparture(), departureAirport: "del" as never },
      connectionPolicy(),
    )).toThrow(ZodError);
  });

  it("rejects negative minConnectionMinutes", () => {
    expect(() => evaluateConnectionFeasibility(
      verifiedArrival(),
      dependentDeparture(),
      ConnectionPolicySchema.parse({ ...connectionPolicy(), minConnectionMinutes: -1 }),
    )).toThrow();
  });

  it("rejects extra fields on VerifiedPrefixArrivalFact", () => {
    expect(VerifiedPrefixArrivalFactSchema.safeParse({
      ...verifiedArrival(),
      extraField: true,
    }).success).toBe(false);
  });

  it("rejects extra fields on DependentDepartureFact", () => {
    expect(DependentDepartureFactSchema.safeParse({
      ...dependentDeparture(),
      extraField: true,
    }).success).toBe(false);
  });

  it("rejects extra fields on ConnectionPolicy", () => {
    expect(ConnectionPolicySchema.safeParse({
      ...connectionPolicy(),
      extraField: true,
    }).success).toBe(false);
  });
});
