import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  FlightOfferSchema,
  TripPlanSchema,
  createTripOption,
  type FlightOffer,
} from "@flightbrain/domain";
import { itineraryFingerprint } from "@flightbrain/orchestrator";
import {
  CommercialResolutionSchema,
  MockIntakeOutcomeSchema,
  MockIntakePolicySchema,
  MockIntakeResultSchema,
  SyntheticProvenanceSchema,
  intakeMockOffers,
  intakeMockResult,
  planVerificationJobs,
  resolveCommercialRequests,
  validatePlanForExecution,
  type MockIntakePolicy,
  type MockIntakeResult,
  type SyntheticProvenance,
} from "@flightbrain/composer";
import { discoveryRequest } from "./fixtures/discovery";
import { trustedExecutionContext } from "./fixtures/execution";
import { verificationCandidate, verificationExamples } from "./fixtures/verification";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively freeze a value — verifies pure functions do not mutate inputs. */
function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
}

function makePolicy(overrides: Partial<MockIntakePolicy> = {}): MockIntakePolicy {
  return MockIntakePolicySchema.parse({
    asOf: "2026-11-15T12:00:00.000Z",
    seed: 42,
    offersPerDescriptor: 2,
    offerValidityMs: 3_600_000, // 1 hour
    currency: "USD",
    ...overrides,
  });
}

function makeProvenance(overrides: Partial<SyntheticProvenance> = {}): SyntheticProvenance {
  return SyntheticProvenanceSchema.parse({
    providerId: "mock:test-provider",
    synthetic: true,
    disclaimer:
      "SYNTHETIC DATA — no real fares, schedules or carriers. For integration testing only.",
    ...overrides,
  });
}

type CtxDeparture =
  | { kind: "date"; date: string }
  | { kind: "window"; startAt: string; endAt: string }
  | { kind: "unspecified" };

/** Build a minimal resolved CommercialResolution for a single DEL->SFO job. */
function buildResolution(
  routeFilter: string[],
  departureKind: "date" | "window" | "unspecified" = "date",
  passengers: { count: number } | null = { count: 2 },
) {
  const departure: CtxDeparture =
    departureKind === "date"
      ? { kind: "date" as const, date: "2026-11-20" }
      : departureKind === "window"
        ? {
            kind: "window" as const,
            startAt: "2026-11-20T00:00:00Z",
            endAt: "2026-11-21T00:00:00Z",
          }
        : { kind: "unspecified" as const };

  const ctx = trustedExecutionContext({ departure, passengers });
  const request = {
    ...discoveryRequest(),
    origin: { kind: "airport" as const, iataCode: routeFilter[0] },
    destination: { kind: "airport" as const, iataCode: routeFilter[routeFilter.length - 1] },
    departure: ctx.departure,
    passengers: ctx.passengers,
  };
  const candidate = verificationCandidate(routeFilter);
  const plan = planVerificationJobs(request, [candidate], {
    asOf: "2026-09-21T10:00:00Z",
    maxCandidateAgeMs: 60_000,
    maxCandidates: 10,
    maxLegsPerCandidate: 8,
    maxJobs: 100,
  });
  const admissibility = validatePlanForExecution(plan, ctx);
  return resolveCommercialRequests(plan, admissibility, ctx);
}

/** Extract the first resolved descriptor from a resolution. */
function firstDescriptor(resolution: ReturnType<typeof buildResolution>) {
  const d = resolution.decisions.find((d) => d.outcome === "resolved");
  if (!d || d.outcome !== "resolved") throw new Error("No resolved descriptor in fixture");
  return d.descriptor;
}

// ---------------------------------------------------------------------------
// (1) Determinism: same inputs → deeply-equal output twice
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("produces identical outcomes on two identical calls", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy();
    const provenance = makeProvenance();

    const a = intakeMockOffers(descriptor, policy, provenance);
    const b = intakeMockOffers(descriptor, policy, provenance);
    expect(a).toEqual(b);
  });

  it("produces identical ids, prices, timestamps and order on repeated calls", () => {
    const resolution = buildResolution(["DEL", "NRT", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 3 });
    const provenance = makeProvenance();

    const a = intakeMockOffers(descriptor, policy, provenance);
    const b = intakeMockOffers(descriptor, policy, provenance);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// (2) Different seed → different but schema-valid set
// ---------------------------------------------------------------------------

describe("seed sensitivity", () => {
  it("different seed produces different but schema-valid offers", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy42 = makePolicy({ seed: 42 });
    const policy99 = makePolicy({ seed: 99 });
    const provenance = makeProvenance();

    const a = intakeMockOffers(descriptor, policy42, provenance);
    const b = intakeMockOffers(descriptor, policy99, provenance);

    // Both valid outcomes
    expect(MockIntakeOutcomeSchema.safeParse(a).success).toBe(true);
    expect(MockIntakeOutcomeSchema.safeParse(b).success).toBe(true);

    // Should produce different results
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));

    // Both offered sets individually schema-valid
    expect(a.outcome).toBe("offered");
    expect(b.outcome).toBe("offered");
    if (a.outcome === "offered")
      for (const offer of a.offers) expect(FlightOfferSchema.safeParse(offer).success).toBe(true);
    if (b.outcome === "offered")
      for (const offer of b.offers) expect(FlightOfferSchema.safeParse(offer).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (3) Source-text scan: no Math.random / Date.now / new Date() / fetch
// ---------------------------------------------------------------------------

describe("source-text restrictions", () => {
  it("intake.ts contains no Math.random, Date.now, new Date() without arg, or fetch(", () => {
    const source = readFileSync(
      new URL("../packages/composer/src/intake.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/Date\.now/);
    // Allow new Date(someArg) but not bare new Date()
    expect(source).not.toMatch(/new Date\(\)/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// (4) freezeDeep input — no throw, no mutation
// ---------------------------------------------------------------------------

describe("purity — frozen inputs", () => {
  it("does not throw on frozen inputs and does not mutate them", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy();
    const provenance = makeProvenance();

    const beforeDescriptor = structuredClone(descriptor);
    const beforePolicy = structuredClone(policy);
    const beforeProvenance = structuredClone(provenance);

    freezeDeep(descriptor);
    freezeDeep(policy);
    freezeDeep(provenance);

    expect(() => intakeMockOffers(descriptor, policy, provenance)).not.toThrow();

    expect(descriptor).toEqual(beforeDescriptor);
    expect(policy).toEqual(beforePolicy);
    expect(provenance).toEqual(beforeProvenance);
  });
});

// ---------------------------------------------------------------------------
// (5) Every offer passes FlightOfferSchema
// ---------------------------------------------------------------------------

describe("offer schema validity", () => {
  it("every synthesized offer passes FlightOfferSchema", () => {
    const resolution = buildResolution(["DEL", "NRT", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 3 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") throw new Error("Expected offered outcome");

    for (const offer of outcome.offers) {
      const result = FlightOfferSchema.safeParse(offer);
      if (!result.success) {
        throw new Error(`Offer failed schema: ${JSON.stringify(result.error.issues)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (6) Malformed descriptor throws at parse boundary
// ---------------------------------------------------------------------------

describe("parse boundary enforcement", () => {
  it("throws ZodError for a null descriptor", () => {
    const policy = makePolicy();
    const provenance = makeProvenance();
    expect(() => intakeMockOffers(null, policy, provenance)).toThrow(ZodError);
  });

  it("throws ZodError for an object missing required fields", () => {
    const policy = makePolicy();
    const provenance = makeProvenance();
    expect(() => intakeMockOffers({ origin: "DEL" }, policy, provenance)).toThrow(ZodError);
  });

  it("throws ZodError for a malformed policy", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const provenance = makeProvenance();
    expect(() => intakeMockOffers(descriptor, { seed: -1 }, provenance)).toThrow(ZodError);
  });

  it("throws ZodError for a provenance with a non-mock: providerId", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy();
    expect(() =>
      intakeMockOffers(descriptor, policy, {
        providerId: "real-provider",
        synthetic: true,
        disclaimer: "test",
      }),
    ).toThrow(ZodError);
  });
});

// ---------------------------------------------------------------------------
// (7) Corrupted offeredJobIds fails MockIntakeResultSchema.safeParse
// ---------------------------------------------------------------------------

describe("MockIntakeResultSchema superRefine invariant", () => {
  it("corrupted offeredJobIds (extra entry) fails safeParse", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const policy = makePolicy();
    const provenance = makeProvenance();
    const result = intakeMockResult(resolution, policy, provenance);

    const corrupted = JSON.parse(JSON.stringify(result)) as MockIntakeResult;
    corrupted.offeredJobIds.push(9999);
    expect(MockIntakeResultSchema.safeParse(corrupted).success).toBe(false);
  });

  it("corrupted offeredJobIds (missing entry) fails safeParse", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const policy = makePolicy();
    const provenance = makeProvenance();
    const result = intakeMockResult(resolution, policy, provenance);

    expect(result.offeredJobIds.length).toBeGreaterThan(0);
    const corrupted = JSON.parse(JSON.stringify(result)) as MockIntakeResult;
    corrupted.offeredJobIds.pop();
    expect(MockIntakeResultSchema.safeParse(corrupted).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (8) Provider matches /^mock:/ and provenance synthetic:true + disclaimer
// ---------------------------------------------------------------------------

describe("provenance checks", () => {
  it("every offer provider matches /^mock:/ and providerMetadata has synthetic:true and disclaimer", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 3 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    for (const offer of outcome.offers) {
      expect(offer.provider).toMatch(/^mock:/);
      expect(offer.providerMetadata["synthetic"]).toBe(true);
      expect(typeof offer.providerMetadata["disclaimer"]).toBe("string");
      expect((offer.providerMetadata["disclaimer"] as string).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// (9) retrievedAt === asOf, expiresAt === asOf + offerValidityMs
// ---------------------------------------------------------------------------

describe("timestamps", () => {
  it("retrievedAt equals policy.asOf exactly", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy();
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    for (const offer of outcome.offers) {
      expect(offer.retrievedAt).toBe(policy.asOf);
    }
  });

  it("expiresAt equals asOf + offerValidityMs when validity > 0", () => {
    const asOf = "2026-11-15T12:00:00.000Z";
    const offerValidityMs = 3_600_000;
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ asOf, offerValidityMs });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    const expectedExpiry = new Date(Date.parse(asOf) + offerValidityMs).toISOString().replace(/(\.\d{3})Z$/, "$1Z");
    for (const offer of outcome.offers) {
      expect(offer.expiresAt).toBe(expectedExpiry);
    }
  });

  it("expiresAt is null when offerValidityMs is 0", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offerValidityMs: 0 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    for (const offer of outcome.offers) {
      expect(offer.expiresAt).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// (10) requiresRevalidation is true
// ---------------------------------------------------------------------------

describe("requiresRevalidation", () => {
  it("every synthesized offer has requiresRevalidation === true", () => {
    const resolution = buildResolution(["DEL", "NRT", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 3 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    for (const offer of outcome.offers) {
      expect(offer.requiresRevalidation).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (11) bookingUrl is null
// ---------------------------------------------------------------------------

describe("bookingUrl", () => {
  it("every synthesized offer has bookingUrl === null", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 2 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    for (const offer of outcome.offers) {
      expect(offer.bookingUrl).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// (12) Segments trace routeFilter exactly; origin/dest match
// ---------------------------------------------------------------------------

describe("segment route tracing", () => {
  it("segments trace routeFilter airports exactly for a direct flight", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 2 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    for (const offer of outcome.offers) {
      const segments = offer.journeys[0].segments;
      expect(segments).toHaveLength(1);
      expect(segments[0].origin).toBe("DEL");
      expect(segments[0].destination).toBe("SFO");
      expect(offer.journeys[0].segments[0].origin).toBe(descriptor.origin);
      expect(offer.journeys[0].segments[offer.journeys[0].segments.length - 1].destination).toBe(descriptor.destination);
    }
  });

  it("segments trace routeFilter for a multi-stop route", () => {
    const resolution = buildResolution(["DEL", "NRT", "LAX", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 2 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    for (const offer of outcome.offers) {
      const segs = offer.journeys[0].segments;
      expect(segs).toHaveLength(3);
      expect(segs[0].origin).toBe("DEL");
      expect(segs[0].destination).toBe("NRT");
      expect(segs[1].origin).toBe("NRT");
      expect(segs[1].destination).toBe("LAX");
      expect(segs[2].origin).toBe("LAX");
      expect(segs[2].destination).toBe("SFO");
    }
  });
});

// ---------------------------------------------------------------------------
// (13) Date departure → first segment on that date; non-date → declined
// ---------------------------------------------------------------------------

describe("departure rules", () => {
  it("date departure → first segment departs on the specified date", () => {
    const resolution = buildResolution(["DEL", "SFO"], "date");
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 2 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    const departureDate = (descriptor.departure as { kind: "date"; date: string }).date;
    for (const offer of outcome.offers) {
      const firstDep = offer.journeys[0].segments[0].departureAt;
      // Date part (UTC) must match
      expect(firstDep.substring(0, 10)).toBe(departureDate);
    }
  });

  it("window departure → declined with departure_not_concrete", () => {
    const resolution = buildResolution(["DEL", "SFO"], "window");
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy();
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("declined");
    if (outcome.outcome !== "declined") return;
    expect(outcome.reason).toBe("departure_not_concrete");
  });
});

// ---------------------------------------------------------------------------
// (14) passengers null → declined/passengers_unresolved; count carried through
// ---------------------------------------------------------------------------

describe("passenger rules", () => {
  it("null passengers → declined with passengers_unresolved", () => {
    const resolution = buildResolution(["DEL", "SFO"], "date", null);
    const descriptor = firstDescriptor(resolution);
    // Manually force passengers to null since resolution with null passengers resolves
    const nullPassengersDescriptor = { ...descriptor, passengers: null };
    const policy = makePolicy();
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(nullPassengersDescriptor, policy, provenance);
    expect(outcome.outcome).toBe("declined");
    if (outcome.outcome !== "declined") return;
    expect(outcome.reason).toBe("passengers_unresolved");
  });

  it("positive passenger count is accepted and offers are synthesized", () => {
    const resolution = buildResolution(["DEL", "SFO"], "date", { count: 3 });
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy();
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
  });
});

// ---------------------------------------------------------------------------
// (15) jobId echoed; batch intakeMockResult preserves requestId + order
// ---------------------------------------------------------------------------

describe("jobId and requestId preservation", () => {
  it("outcome jobId matches the descriptor jobId", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy();
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.jobId).toBe(descriptor.jobId);
  });

  it("intakeMockResult preserves requestId and processes outcomes in descriptor order", () => {
    const resolution = buildResolution(["DEL", "NRT", "SFO"]);
    const policy = makePolicy();
    const provenance = makeProvenance();

    const result = intakeMockResult(resolution, policy, provenance);
    expect(result.kind).toBe("mock_intake");
    expect(result.requestId).toBe(resolution.requestId);

    // outcomes must be in the same order as resolved decisions
    const resolvedDecisions = resolution.decisions.filter((d) => d.outcome === "resolved");
    expect(result.outcomes).toHaveLength(resolvedDecisions.length);
    for (let i = 0; i < resolvedDecisions.length; i++) {
      const dec = resolvedDecisions[i];
      if (dec.outcome !== "resolved") continue;
      expect(result.outcomes[i].jobId).toBe(dec.descriptor.jobId);
    }
  });

  it("offeredJobIds matches offered outcomes in order", () => {
    const resolution = buildResolution(["DEL", "NRT", "SFO"]);
    const policy = makePolicy();
    const provenance = makeProvenance();

    const result = intakeMockResult(resolution, policy, provenance);
    const expectedOfferedIds = result.outcomes
      .filter((o) => o.outcome === "offered")
      .map((o) => o.jobId);
    expect(result.offeredJobIds).toEqual(expectedOfferedIds);
  });
});

// ---------------------------------------------------------------------------
// (16) E4→E6 compatibility: synthesized offer accepted as TripPlan.sourceOffers entry
// ---------------------------------------------------------------------------

describe("E4→E6 compatibility (createTripOption)", () => {
  it("a synthesized offer can be used in a single-component TripPlan and createTripOption succeeds", () => {
    const resolution = buildResolution(["DEL", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 1 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") throw new Error("Expected offered outcome");
    expect(outcome.offers).toHaveLength(1);

    const offer = outcome.offers[0];

    // Build the minimal TripPlan
    const plan = TripPlanSchema.parse({
      id: "e4-e6-test-trip",
      sourceOffers: [offer],
      bookingComponents: [
        {
          id: "component-0",
          provider: offer.provider,
          providerOfferId: offer.providerOfferId,
          offerId: offer.id,
          sourceOfferIndex: 0,
          scheduleFingerprint: null, // null because operatingCarrier is null
          order: 0,
          payment: { kind: "cash", amount: offer.totalPrice },
        },
      ],
      journeys: [
        {
          requestedOrigin: offer.journeys[0].segments[0].origin,
          requestedDestination:
            offer.journeys[0].segments[offer.journeys[0].segments.length - 1].destination,
          segments: offer.journeys[0].segments.map((_, si) => ({
            componentIndex: 0,
            journeyIndex: 0,
            segmentIndex: si,
          })),
        },
      ],
      protectionFacts: [],
    });

    // createTripOption must succeed without throwing
    expect(() => createTripOption(plan)).not.toThrow();
    const tripOption = createTripOption(plan);
    expect(tripOption.id).toBe("e4-e6-test-trip");
    expect(tripOption.sourceOffers).toHaveLength(1);
    expect(tripOption.sourceOffers[0].provider).toMatch(/^mock:/);
  });
});

// ---------------------------------------------------------------------------
// (17) Multi-stop routeFilter yields valid ordered multi-segment journey
// ---------------------------------------------------------------------------

describe("multi-stop route synthesis", () => {
  it("DEL-NRT-SFO yields a valid 2-segment ordered journey", () => {
    const resolution = buildResolution(["DEL", "NRT", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 2 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    for (const offer of outcome.offers) {
      const segs = offer.journeys[0].segments;
      expect(segs).toHaveLength(2);
      expect(segs[0].origin).toBe("DEL");
      expect(segs[0].destination).toBe("NRT");
      expect(segs[1].origin).toBe("NRT");
      expect(segs[1].destination).toBe("SFO");

      // Chronological order: each segment departs after the previous arrives.
      expect(Date.parse(segs[1].departureAt)).toBeGreaterThan(Date.parse(segs[0].arrivalAt));

      // Full offer still passes FlightOfferSchema.
      expect(FlightOfferSchema.safeParse(offer).success).toBe(true);
    }
  });

  it("DEL-NRT-LAX-SFO (3-segment) yields ordered valid segments", () => {
    const resolution = buildResolution(["DEL", "NRT", "LAX", "SFO"]);
    const descriptor = firstDescriptor(resolution);
    const policy = makePolicy({ offersPerDescriptor: 1 });
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("offered");
    if (outcome.outcome !== "offered") return;

    for (const offer of outcome.offers) {
      const segs = offer.journeys[0].segments;
      expect(segs).toHaveLength(3);
      for (let i = 1; i < segs.length; i++) {
        expect(Date.parse(segs[i].departureAt)).toBeGreaterThan(Date.parse(segs[i - 1].arrivalAt));
      }
      expect(FlightOfferSchema.safeParse(offer).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Additional schema-level invariant checks
// ---------------------------------------------------------------------------

describe("MockIntakePolicySchema validation", () => {
  it("rejects negative seed", () => {
    expect(MockIntakePolicySchema.safeParse({ ...makePolicy(), seed: -1 }).success).toBe(false);
  });

  it("rejects offersPerDescriptor > 20", () => {
    expect(MockIntakePolicySchema.safeParse({ ...makePolicy(), offersPerDescriptor: 21 }).success).toBe(false);
  });

  it("rejects unsupported currency", () => {
    expect(MockIntakePolicySchema.safeParse({ ...makePolicy(), currency: "CNY" }).success).toBe(false);
  });
});

describe("SyntheticProvenanceSchema validation", () => {
  it("rejects providerId not starting with mock:", () => {
    expect(SyntheticProvenanceSchema.safeParse({
      providerId: "real-provider",
      synthetic: true,
      disclaimer: "test",
    }).success).toBe(false);
  });

  it("rejects non-literal synthetic field", () => {
    expect(SyntheticProvenanceSchema.safeParse({
      providerId: "mock:x",
      synthetic: false,
      disclaimer: "test",
    }).success).toBe(false);
  });

  it("rejects blank disclaimer", () => {
    expect(SyntheticProvenanceSchema.safeParse({
      providerId: "mock:x",
      synthetic: true,
      disclaimer: "",
    }).success).toBe(false);
  });
});

describe("route depth limit", () => {
  it("route filter with 6 airports (5 segments) → declined/route_filter_unsupported", () => {
    // Directly construct a descriptor bypassing the build pipeline for this edge case.
    const descriptor = {
      origin: "DEL",
      destination: "SFO",
      routeFilter: ["DEL", "DOH", "LHR", "JFK", "LAX", "SFO"],
      departure: { kind: "date" as const, date: "2026-11-20" },
      passengers: { count: 1 },
      jobId: 0,
    };
    const policy = makePolicy();
    const provenance = makeProvenance();

    const outcome = intakeMockOffers(descriptor, policy, provenance);
    expect(outcome.outcome).toBe("declined");
    if (outcome.outcome !== "declined") return;
    expect(outcome.reason).toBe("route_filter_unsupported");
  });
});
