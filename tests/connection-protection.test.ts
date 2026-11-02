import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ConnectionProtectionFactSchema,
  createTripOption,
  type TripPlan,
} from "@flightbrain/domain";
import {
  assessConnectionProtection,
  assessItineraryProtection,
  ConnectionBoundaryInputSchema,
  ItineraryProtectionResultSchema,
  ProtectionAssessmentSchema,
  SingleTicketEvidenceSchema,
  type ConnectionBoundaryInput,
  type SingleTicketEvidence,
} from "@flightbrain/composer";
import { planFor, syntheticOffer, tripSegments } from "./fixtures/trips";

// Synthetic fixtures; no real schedules, fares, or provider capability claims.
const SYNTH_PROVIDER = "synth-provider";
const SYNTH_OFFER_ID = "synth-offer-123";
const SYNTH_REFERENCE = "synth-ref-ABC";

// A valid fb:schedule:v1 fingerprint (64 lowercase hex chars).
const VALID_FINGERPRINT =
  "fb:schedule:v1:4ee92e03d824498cb999249eb739d6aa5dfd22b62f8d466ea1ee1fd73827ccd7";

function sameComponentEvidence(
  overrides: Partial<{ provider: string; providerOfferId: string; reference: string }> = {},
): SingleTicketEvidence {
  return {
    kind: "same_component",
    provider: overrides.provider ?? SYNTH_PROVIDER,
    providerOfferId: overrides.providerOfferId ?? SYNTH_OFFER_ID,
    reference: overrides.reference ?? SYNTH_REFERENCE,
  };
}

function boundary(
  overrides: Partial<ConnectionBoundaryInput> = {},
): ConnectionBoundaryInput {
  return ConnectionBoundaryInputSchema.parse({
    journeyIndex: 0,
    fromSegmentIndex: 0,
    fromComponentIndex: 0,
    toComponentIndex: 0,
    evidence: { kind: "none" },
    ...overrides,
  });
}

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.values(value as object).forEach(freezeDeep);
    Object.freeze(value);
  }
}

// ---------------------------------------------------------------------------
// 1. Property-style matrix: {crosses}x{evidence kind} -> exactly one protected cell
// ---------------------------------------------------------------------------

describe("property matrix: protection state", () => {
  it.each([
    // crosses=false, evidence=same_component => protected (ONE protected cell)
    { crosses: false, evidenceKind: "same_component", expected: "protected" },
    // crosses=false, evidence=none => unknown
    { crosses: false, evidenceKind: "none", expected: "unknown" },
    // crosses=true, evidence=same_component => self_transfer (structural wins)
    { crosses: true, evidenceKind: "same_component", expected: "self_transfer" },
    // crosses=true, evidence=none => self_transfer
    { crosses: true, evidenceKind: "none", expected: "self_transfer" },
  ])("crosses=$crosses evidenceKind=$evidenceKind => $expected", ({ crosses, evidenceKind, expected }) => {
    const fromComponentIndex = 0;
    const toComponentIndex = crosses ? 1 : 0;
    const evidence: SingleTicketEvidence =
      evidenceKind === "same_component" ? sameComponentEvidence() : { kind: "none" };

    const result = assessConnectionProtection(boundary({ fromComponentIndex, toComponentIndex, evidence }));
    expect(result.protection).toBe(expected);

    // Verify exactly one cell yields protected across the full matrix
    if (expected === "protected") {
      expect(crosses).toBe(false);
      expect(evidenceKind).toBe("same_component");
    }
  });

  it("protected appears in exactly one cell of the 2x2 matrix", () => {
    const cells = [
      { crosses: false, evidenceKind: "same_component" as const },
      { crosses: false, evidenceKind: "none" as const },
      { crosses: true, evidenceKind: "same_component" as const },
      { crosses: true, evidenceKind: "none" as const },
    ].map(({ crosses, evidenceKind }) => {
      const evidence: SingleTicketEvidence =
        evidenceKind === "same_component" ? sameComponentEvidence() : { kind: "none" };
      const toComponentIndex = crosses ? 1 : 0;
      return assessConnectionProtection(boundary({ fromComponentIndex: 0, toComponentIndex, evidence })).protection;
    });
    expect(cells.filter((p) => p === "protected")).toHaveLength(1);
    expect(cells.filter((p) => p === "self_transfer")).toHaveLength(2);
    expect(cells.filter((p) => p === "unknown")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Crossing boundary -> self_transfer even when same_component evidence passed
// ---------------------------------------------------------------------------

describe("structural boundary wins unconditionally", () => {
  it("crossing boundary with same_component evidence yields self_transfer, not protected", () => {
    const result = assessConnectionProtection(boundary({
      fromComponentIndex: 0,
      toComponentIndex: 1,
      evidence: sameComponentEvidence(),
    }));
    expect(result.protection).toBe("self_transfer");
    expect(result.crossesBookingBoundary).toBe(true);
    // Evidence in output should reflect the structural rule (none), not the input
    expect(result.evidence.kind).toBe("none");
  });

  it("large index gap crossing boundary still yields self_transfer", () => {
    const result = assessConnectionProtection(boundary({
      fromComponentIndex: 2,
      toComponentIndex: 5,
      evidence: sameComponentEvidence(),
    }));
    expect(result.protection).toBe("self_transfer");
    expect(result.crossesBookingBoundary).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Same-component + none -> unknown (never protected or self_transfer)
// ---------------------------------------------------------------------------

describe("same-component with no evidence yields unknown", () => {
  it("same component + none evidence -> unknown", () => {
    const result = assessConnectionProtection(boundary({
      fromComponentIndex: 0,
      toComponentIndex: 0,
      evidence: { kind: "none" },
    }));
    expect(result.protection).toBe("unknown");
    expect(result.crossesBookingBoundary).toBe(false);
    expect(result.evidence.kind).toBe("none");
  });

  it("unknown protection is never protected or self_transfer", () => {
    const result = assessConnectionProtection(boundary({ fromComponentIndex: 0, toComponentIndex: 0, evidence: { kind: "none" } }));
    expect(result.protection).not.toBe("protected");
    expect(result.protection).not.toBe("self_transfer");
  });
});

// ---------------------------------------------------------------------------
// 4. Blank/whitespace reference or missing provider/providerOfferId fails schema parse
// ---------------------------------------------------------------------------

describe("schema validation of same_component evidence fields", () => {
  it.each([
    // blank reference
    { provider: SYNTH_PROVIDER, providerOfferId: SYNTH_OFFER_ID, reference: "" },
    // whitespace-only reference
    { provider: SYNTH_PROVIDER, providerOfferId: SYNTH_OFFER_ID, reference: "   " },
    // leading whitespace reference
    { provider: SYNTH_PROVIDER, providerOfferId: SYNTH_OFFER_ID, reference: " valid-ref" },
    // blank provider
    { provider: "", providerOfferId: SYNTH_OFFER_ID, reference: SYNTH_REFERENCE },
    // blank providerOfferId
    { provider: SYNTH_PROVIDER, providerOfferId: "", reference: SYNTH_REFERENCE },
  ])("rejects same_component evidence with invalid field: $provider / $providerOfferId / $reference", ({ provider, providerOfferId, reference }) => {
    expect(
      SingleTicketEvidenceSchema.safeParse({ kind: "same_component", provider, providerOfferId, reference }).success,
    ).toBe(false);
  });

  it("invalid same_component evidence never produces a protected assessment", () => {
    // Even if someone bypasses the schema, the parse in assessConnectionProtection should reject it
    const badEvidence = { kind: "same_component", provider: "", providerOfferId: SYNTH_OFFER_ID, reference: SYNTH_REFERENCE };
    expect(
      () => assessConnectionProtection(boundary({ fromComponentIndex: 0, toComponentIndex: 0, evidence: badEvidence as SingleTicketEvidence })),
    ).toThrow();
  });

  it("whitespace reference rejected by schema — cannot produce a protected fact", () => {
    const badBoundary = {
      journeyIndex: 0, fromSegmentIndex: 0, fromComponentIndex: 0, toComponentIndex: 0,
      evidence: { kind: "same_component", provider: SYNTH_PROVIDER, providerOfferId: SYNTH_OFFER_ID, reference: "   " },
    };
    expect(ConnectionBoundaryInputSchema.safeParse(badBoundary).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. protectionFacts round-trip and cross-validation with createTripOption (E5 <-> E6)
// ---------------------------------------------------------------------------

describe("protectionFacts round-trip and E5 to createTripOption cross-validation", () => {
  it("each emitted protectionFact passes ConnectionProtectionFactSchema.parse", () => {
    const [s0, s1] = tripSegments();
    const offer = syntheticOffer([s0, s1], "two-seg-offer");
    const result = assessItineraryProtection({
      scheduleFingerprint: null,
      boundaries: [boundary({
        journeyIndex: 0,
        fromSegmentIndex: 0,
        fromComponentIndex: 0,
        toComponentIndex: 0,
        evidence: sameComponentEvidence({ provider: offer.provider, providerOfferId: offer.providerOfferId }),
      })],
    });
    expect(result.protectionFacts).toHaveLength(1);
    expect(() => ConnectionProtectionFactSchema.parse(result.protectionFacts[0])).not.toThrow();
  });

  it("feeding protectionFacts into createTripOption reproduces the same per-connection protection E5 reported", () => {
    const [s0, s1] = tripSegments();
    const offer = syntheticOffer([s0, s1], "two-seg-offer");
    const result = assessItineraryProtection({
      scheduleFingerprint: null,
      boundaries: [boundary({
        journeyIndex: 0,
        fromSegmentIndex: 0,
        fromComponentIndex: 0,
        toComponentIndex: 0,
        evidence: sameComponentEvidence({ provider: offer.provider, providerOfferId: offer.providerOfferId }),
      })],
    });

    // Build a TripPlan that uses the emitted protectionFacts
    const basePlan = planFor([offer]);
    const plan: TripPlan = { ...basePlan, protectionFacts: result.protectionFacts };

    const trip = createTripOption(plan);
    expect(trip.connections).toHaveLength(1);
    const conn = trip.connections[0];

    // E5 said "protected", E6 (createTripOption) must agree
    expect(conn.protection).toBe(result.assessments[0].protection);
    expect(conn.protection).toBe("protected");
    expect(conn.evidence.kind).toBe("provider");
  });

  it("E5 unknown assessment -> no fact emitted -> createTripOption connection is unknown", () => {
    const [s0, s1] = tripSegments();
    const offer = syntheticOffer([s0, s1], "two-seg-offer");
    const result = assessItineraryProtection({
      scheduleFingerprint: null,
      boundaries: [boundary({ fromComponentIndex: 0, toComponentIndex: 0, evidence: { kind: "none" } })],
    });
    expect(result.protectionFacts).toHaveLength(0);
    expect(result.assessments[0].protection).toBe("unknown");

    const plan = planFor([offer]);
    const trip = createTripOption(plan);
    expect(trip.connections[0].protection).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 6. Valid fingerprint carried verbatim; null carried as null
// ---------------------------------------------------------------------------

describe("schedule fingerprint carry-through", () => {
  it("carries a valid fb:schedule:v1 fingerprint verbatim", () => {
    const result = assessItineraryProtection({ scheduleFingerprint: VALID_FINGERPRINT, boundaries: [] });
    expect(result.scheduleFingerprint).toBe(VALID_FINGERPRINT);
  });

  it("carries null as null", () => {
    const result = assessItineraryProtection({ scheduleFingerprint: null, boundaries: [] });
    expect(result.scheduleFingerprint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Non-V1 / self-computed digest is rejected at parse
// ---------------------------------------------------------------------------

describe("fingerprint validation", () => {
  it.each([
    "fb:schedule:v2:4ee92e03d824498cb999249eb739d6aa5dfd22b62f8d466ea1ee1fd73827ccd7",
    "fb:schedule:v1:4ee92e03d824498cb999249eb739d6aa5dfd22b62f8d466ea1ee1fd73827ccd",   // 63 hex
    "fb:schedule:v1:4ee92e03d824498cb999249eb739d6aa5dfd22b62f8d466ea1ee1fd73827ccd700", // 65 hex
    "fb:schedule:v1:4EE92E03D824498CB999249EB739D6AA5DFD22B62F8D466EA1EE1FD73827CCD7",   // uppercase
    "4ee92e03d824498cb999249eb739d6aa5dfd22b62f8d466ea1ee1fd73827ccd7",                  // no prefix
    "",
    "random-string",
    "fb:schedule:v1:4ee92e03d824498cb999249eb739d6aa5dfd22b62f8d466ea1ee1fd73827ccd7 ",  // trailing space
  ])("rejects invalid fingerprint %s", (fingerprint) => {
    expect(() => assessItineraryProtection({ scheduleFingerprint: fingerprint, boundaries: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. Determinism: same input -> deeply equal output, property insertion-order permutations
// ---------------------------------------------------------------------------

describe("determinism", () => {
  const testBoundaries: ConnectionBoundaryInput[] = [
    boundary({ fromComponentIndex: 0, toComponentIndex: 0, evidence: sameComponentEvidence() }),
    boundary({ fromSegmentIndex: 1, fromComponentIndex: 0, toComponentIndex: 0, evidence: { kind: "none" } }),
    boundary({ fromSegmentIndex: 2, fromComponentIndex: 0, toComponentIndex: 1, evidence: sameComponentEvidence() }),
  ];

  it("repeated calls with same input produce deeply equal output", () => {
    const input = { scheduleFingerprint: VALID_FINGERPRINT, boundaries: testBoundaries };
    const r1 = assessItineraryProtection(input);
    const r2 = assessItineraryProtection(input);
    expect(r1).toEqual(r2);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("property insertion-order permutations produce equal output", () => {
    function reverseKeys<T extends object>(obj: T): T {
      return Object.fromEntries(Object.entries(obj).reverse()) as T;
    }
    const b = testBoundaries[0];
    const bReversed = reverseKeys(b);
    const r1 = assessConnectionProtection(b);
    const r2 = assessConnectionProtection(bReversed);
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// 9. Fresh-process TZ test + source grep for Date.now/Math.random/new Date()-no-arg
// ---------------------------------------------------------------------------

describe("timezone and purity", () => {
  it.each(["UTC", "Europe/Stockholm", "Pacific/Honolulu"])(
    "produces identical output in fresh process with TZ=%s",
    (timezone) => {
      const moduleUrl = new URL(
        "../packages/composer/src/protection.ts",
        import.meta.url,
      ).href;
      const loaderUrl = new URL("./fixtures/module-loader.mjs", import.meta.url).href;
      const b = boundary({ fromComponentIndex: 0, toComponentIndex: 0, evidence: sameComponentEvidence() });
      const script = [
        `import { assessConnectionProtection } from ${JSON.stringify(moduleUrl)};`,
        `import { readFileSync } from "node:fs";`,
        `const b = JSON.parse(readFileSync(0, "utf8"));`,
        `process.stdout.write(JSON.stringify(assessConnectionProtection(b)));`,
      ].join("\n");
      const r1 = execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--experimental-loader", loaderUrl, "--input-type=module", "--eval", script],
        { input: JSON.stringify(b), encoding: "utf8", env: { ...process.env, TZ: timezone } },
      );
      const r2 = execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--experimental-loader", loaderUrl, "--input-type=module", "--eval", script],
        { input: JSON.stringify(b), encoding: "utf8", env: { ...process.env, TZ: "UTC" } },
      );
      expect(JSON.parse(r1)).toEqual(JSON.parse(r2));
    },
    // Each case spawns two fresh Node subprocesses (strip-types + loader); under the
    // full parallel suite that can exceed vitest's 5s default, so give explicit headroom.
    // Assertions are unchanged — this only prevents load-induced timeout flakiness.
    30_000,
  );

  it("source file contains no Date.now(), Math.random(), or bare new Date() calls", () => {
    const src = readFileSync(
      new URL("../packages/composer/src/protection.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/Math\.random\s*\(/);
    // Bare new Date() with no arguments
    expect(src).not.toMatch(/new Date\s*\(\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// 10. Pure/no-mutation: freezeDeep inputs, independent output
// ---------------------------------------------------------------------------

describe("pure function: no mutation of inputs", () => {
  it("frozen inputs do not throw and output is independent", () => {
    const b = boundary({ fromComponentIndex: 0, toComponentIndex: 0, evidence: sameComponentEvidence() });
    const before = structuredClone(b);
    freezeDeep(b);
    const result = assessConnectionProtection(b);
    expect(b).toEqual(before); // input unchanged
    // Mutating result does not affect input
    (result as Record<string, unknown>).protection = "unknown";
    expect(b).toEqual(before);
  });

  it("frozen itinerary input does not throw", () => {
    const input = { scheduleFingerprint: VALID_FINGERPRINT, boundaries: [boundary()] };
    const before = structuredClone(input);
    freezeDeep(input);
    const result = assessItineraryProtection(input);
    expect(input).toEqual(before);
    expect(result).toBeDefined();
  });

  it("independent outputs: mutating one result does not affect another", () => {
    const b = boundary({ fromComponentIndex: 0, toComponentIndex: 0, evidence: sameComponentEvidence() });
    const r1 = assessConnectionProtection(b);
    const r2 = assessConnectionProtection(b);
    (r1 as Record<string, unknown>).protection = "unknown";
    expect(r2.protection).toBe("protected");
  });
});

// ---------------------------------------------------------------------------
// 11. ItineraryProtectionResultSchema.safeParse rejects corrupted results
// ---------------------------------------------------------------------------

describe("ItineraryProtectionResultSchema rejects corrupted results", () => {
  it("rejects a 'protected' assessment carrying boundary-crossing evidence", () => {
    const corrupted = {
      scheduleFingerprint: null,
      assessments: [{
        journeyIndex: 0, fromSegmentIndex: 0,
        crossesBookingBoundary: true,
        protection: "protected",
        evidence: { kind: "same_component", provider: SYNTH_PROVIDER, providerOfferId: SYNTH_OFFER_ID, reference: SYNTH_REFERENCE },
      }],
      protectionFacts: [],
    };
    expect(ItineraryProtectionResultSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a protectionFact whose protection disagrees with the assessment", () => {
    const corrupted = {
      scheduleFingerprint: null,
      assessments: [{
        journeyIndex: 0, fromSegmentIndex: 0,
        crossesBookingBoundary: false,
        protection: "unknown",
        evidence: { kind: "none" },
      }],
      protectionFacts: [{
        journeyIndex: 0, fromSegmentIndex: 0,
        protection: "protected",
        reference: SYNTH_REFERENCE,
      }],
    };
    expect(ItineraryProtectionResultSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a 'protected' assessment with evidence kind 'none'", () => {
    const corrupted = {
      scheduleFingerprint: null,
      assessments: [{
        journeyIndex: 0, fromSegmentIndex: 0,
        crossesBookingBoundary: false,
        protection: "protected",
        evidence: { kind: "none" },
      }],
      protectionFacts: [],
    };
    expect(ItineraryProtectionResultSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects an 'unknown' assessment with same_component evidence", () => {
    const corrupted = {
      scheduleFingerprint: null,
      assessments: [{
        journeyIndex: 0, fromSegmentIndex: 0,
        crossesBookingBoundary: false,
        protection: "unknown",
        evidence: { kind: "same_component", provider: SYNTH_PROVIDER, providerOfferId: SYNTH_OFFER_ID, reference: SYNTH_REFERENCE },
      }],
      protectionFacts: [],
    };
    expect(ItineraryProtectionResultSchema.safeParse(corrupted).success).toBe(false);
  });

  it("accepts a valid result", () => {
    const valid = assessItineraryProtection({
      scheduleFingerprint: VALID_FINGERPRINT,
      boundaries: [boundary({ fromComponentIndex: 0, toComponentIndex: 0, evidence: sameComponentEvidence() })],
    });
    expect(ItineraryProtectionResultSchema.safeParse(valid).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Import-isolation: protection.ts imports only @flightbrain/domain + local + zod
// ---------------------------------------------------------------------------

describe("import isolation", () => {
  it("protection.ts imports only @flightbrain/domain, local composer files, and zod", () => {
    const src = readFileSync(
      new URL("../packages/composer/src/protection.ts", import.meta.url),
      "utf8",
    );
    const imports = [...src.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const allowed = ["@flightbrain/domain", "zod"];
    // Allow local relative imports (but not orchestrator or crypto)
    for (const imp of imports) {
      const isAllowed =
        allowed.includes(imp) ||
        (imp.startsWith("./") && !imp.includes("orchestrator"));
      expect(isAllowed, `Unexpected import: ${imp}`).toBe(true);
    }
  });

  it("protection.ts does not import @flightbrain/orchestrator", () => {
    const src = readFileSync(
      new URL("../packages/composer/src/protection.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("@flightbrain/orchestrator");
  });

  it("protection.ts does not use node:crypto or createHash", () => {
    const src = readFileSync(
      new URL("../packages/composer/src/protection.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("node:crypto");
    expect(src).not.toContain("createHash");
  });

  it("protection.ts does not contain the fingerprint hash literal or flightbrain-schedule marker", () => {
    const src = readFileSync(
      new URL("../packages/composer/src/protection.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("flightbrain-schedule");
    expect(src).not.toContain("sha256");
  });
});
