/**
 * E6 Trip Composition acceptance tests.
 * Synthetic fixtures — no live schedules, fares, or provider capability claims.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  FlightOfferSchema,
  TripOptionSchema,
  type FlightOffer,
  type TripOption,
} from "@flightbrain/domain";
import { itineraryFingerprint } from "@flightbrain/orchestrator";
import {
  composeTripOption,
  composeTripOptions,
  TripCompositionRequestSchema,
  TripCompositionResultSchema,
  type TripCompositionRequest,
  type TripCompositionResult,
} from "@flightbrain/composer";
import { offerWithJourneys } from "./fixtures/journeys";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const RETRIEVED_AT = "2026-10-01T12:00:00.000Z";
const EXPIRES_AT = "2026-10-01T13:00:00.000Z";

/** Build a concrete FlightOffer with known operatingCarrier/Flight (fingerprint-able). */
function makeOffer(
  id: string,
  segments: Array<{
    origin: string;
    destination: string;
    departureAt: string;
    arrivalAt: string;
    carrier?: string;
    flightNumber?: string;
  }>,
): FlightOffer {
  return FlightOfferSchema.parse({
    id,
    journeys: [
      {
        segments: segments.map((s) => ({
          origin: s.origin,
          destination: s.destination,
          departureAt: s.departureAt,
          arrivalAt: s.arrivalAt,
          marketingCarrier: s.carrier ?? "ZZ",
          marketingFlightNumber: s.flightNumber ?? "100",
          operatingCarrier: s.carrier ?? "ZZ",
          operatingFlightNumber: s.flightNumber ?? "100",
          cabin: "economy",
        })),
      },
    ],
    provider: "mock:provider",
    providerOfferId: `source-${id}`,
    bookingUrl: null,
    retrievedAt: RETRIEVED_AT,
    expiresAt: EXPIRES_AT,
    requiresRevalidation: true,
    totalPrice: { amountMinor: "50000", currency: "USD", exponent: 2 },
    refundable: null,
    changeable: null,
    checkedBags: null,
    cabinBags: null,
    warnings: [],
    providerMetadata: { synthetic: true },
  });
}

/** Build a FlightOffer with null operatingCarrier (no fingerprint possible). */
function makeOfferNoIdentity(id: string): FlightOffer {
  return FlightOfferSchema.parse({
    id,
    journeys: [
      {
        segments: [
          {
            origin: "DEL",
            destination: "NRT",
            departureAt: "2026-10-10T00:00:00.000Z",
            arrivalAt: "2026-10-10T08:00:00.000Z",
            marketingCarrier: "ZZ",
            marketingFlightNumber: "100",
            operatingCarrier: null,
            operatingFlightNumber: null,
            cabin: "economy",
          },
        ],
      },
    ],
    provider: "mock:provider",
    providerOfferId: `source-${id}`,
    bookingUrl: null,
    retrievedAt: RETRIEVED_AT,
    expiresAt: EXPIRES_AT,
    requiresRevalidation: true,
    totalPrice: { amountMinor: "50000", currency: "USD", exponent: 2 },
    refundable: null,
    changeable: null,
    checkedBags: null,
    cabinBags: null,
    warnings: [],
    providerMetadata: { synthetic: true },
  });
}

/** Single-component request: DEL → NRT direct. */
function singleComponentRequest(opts?: {
  jobId?: number;
  id?: string;
  offer?: FlightOffer;
  fingerprint?: string | null;
  feasibilityDecisions?: TripCompositionRequest["feasibility"]["decisions"];
  protectionFacts?: TripCompositionRequest["protection"]["protectionFacts"];
}): TripCompositionRequest {
  const offer = opts?.offer ?? makeOffer("offer-del-nrt", [
    { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
  ]);
  const fp = opts?.fingerprint !== undefined ? opts.fingerprint : itineraryFingerprint(offer);
  return TripCompositionRequestSchema.parse({
    id: opts?.id ?? "trip-1",
    jobId: opts?.jobId ?? 0,
    bindings: [
      {
        sourceOffer: offer,
        provider: offer.provider,
        providerOfferId: offer.providerOfferId,
        offerId: offer.id,
        scheduleFingerprint: fp,
        payment: { kind: "cash", amount: offer.totalPrice },
        segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
      },
    ],
    journeys: [
      {
        requestedOrigin: "DEL",
        requestedDestination: "NRT",
        segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
      },
    ],
    protection: {
      protectionFacts: opts?.protectionFacts ?? [],
      scheduleFingerprint: fp,
    },
    feasibility: {
      decisions: opts?.feasibilityDecisions ?? [],
    },
  });
}

/** Two-component request: DEL → NRT (offer-A) then NRT → LAX (offer-B). */
function twoComponentRequest(opts?: {
  jobId?: number;
  feasibilityDecisions?: TripCompositionRequest["feasibility"]["decisions"];
  protectionFacts?: TripCompositionRequest["protection"]["protectionFacts"];
}): TripCompositionRequest {
  const offerA = makeOffer("offer-del-nrt", [
    { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
  ]);
  const offerB = makeOffer("offer-nrt-lax", [
    { origin: "NRT", destination: "LAX", departureAt: "2026-10-10T10:00:00.000Z", arrivalAt: "2026-10-10T22:00:00.000Z" },
  ]);
  const fpA = itineraryFingerprint(offerA);
  const fpB = itineraryFingerprint(offerB);
  return TripCompositionRequestSchema.parse({
    id: "trip-2",
    jobId: opts?.jobId ?? 0,
    bindings: [
      {
        sourceOffer: offerA,
        provider: offerA.provider,
        providerOfferId: offerA.providerOfferId,
        offerId: offerA.id,
        scheduleFingerprint: fpA,
        payment: { kind: "cash", amount: offerA.totalPrice },
        segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
      },
      {
        sourceOffer: offerB,
        provider: offerB.provider,
        providerOfferId: offerB.providerOfferId,
        offerId: offerB.id,
        scheduleFingerprint: fpB,
        payment: { kind: "cash", amount: offerB.totalPrice },
        segments: [{ componentIndex: 1, journeyIndex: 0, segmentIndex: 0 }],
      },
    ],
    journeys: [
      {
        requestedOrigin: "DEL",
        requestedDestination: "LAX",
        segments: [
          { componentIndex: 0, journeyIndex: 0, segmentIndex: 0 },
          { componentIndex: 1, journeyIndex: 0, segmentIndex: 0 },
        ],
      },
    ],
    protection: {
      protectionFacts: opts?.protectionFacts ?? [],
      scheduleFingerprint: fpA,
    },
    feasibility: {
      decisions: opts?.feasibilityDecisions ?? [],
    },
  });
}

function freezeDeep(value: unknown): void {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
}

// ---------------------------------------------------------------------------
// 1. Honest provenance/freshness round-trip
// ---------------------------------------------------------------------------

describe("(1) honest provenance and freshness round-trip", () => {
  it("sourceOffers snapshot equality: provider, providerOfferId, retrievedAt, expiresAt", () => {
    const offer = makeOffer("offer-del-nrt", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
    ]);
    const outcome = composeTripOption(singleComponentRequest({ offer }));
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    const snapshot = outcome.trip.sourceOffers[0];
    expect(snapshot.provider).toBe(offer.provider);
    expect(snapshot.providerOfferId).toBe(offer.providerOfferId);
    expect(snapshot.retrievedAt).toBe(offer.retrievedAt);
    expect(snapshot.expiresAt).toBe(offer.expiresAt);
  });

  it("requiresRevalidation stays true — never cleared", () => {
    const outcome = composeTripOption(singleComponentRequest());
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    expect(outcome.trip.sourceOffers[0].requiresRevalidation).toBe(true);
  });

  it("does not mutate or add fields to source offer", () => {
    const offer = makeOffer("offer-del-nrt", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
    ]);
    const original = JSON.stringify(offer);
    composeTripOption(singleComponentRequest({ offer }));
    expect(JSON.stringify(offer)).toBe(original);
  });

  it("totalPrice round-trips verbatim", () => {
    const offer = makeOffer("offer-del-nrt", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
    ]);
    const outcome = composeTripOption(singleComponentRequest({ offer }));
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    expect(outcome.trip.sourceOffers[0].totalPrice).toEqual(offer.totalPrice);
  });
});

// ---------------------------------------------------------------------------
// 2. Protection never upgraded
// ---------------------------------------------------------------------------

describe("(2) protection never upgraded", () => {
  it("two-component self_transfer connection stays self_transfer + warning", () => {
    const outcome = composeTripOption(twoComponentRequest());
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    const conn = outcome.trip.connections[0];
    expect(conn.protection).toBe("self_transfer");
    expect(conn.crossesBookingBoundary).toBe(true);
    expect(outcome.trip.warnings).toContain("self_transfer");
  });

  it("a protectionFact claiming protected across a booking boundary declines", () => {
    // A fact claiming protection at journeyIndex=0, fromSegmentIndex=0 (the cross-boundary connection)
    // will cause createTripOption to reject it (domain invariant: cross-boundary must be self_transfer).
    // This should map to a decline rather than throw.
    const offerA = makeOffer("offer-del-nrt", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
    ]);
    const offerB = makeOffer("offer-nrt-lax", [
      { origin: "NRT", destination: "LAX", departureAt: "2026-10-10T10:00:00.000Z", arrivalAt: "2026-10-10T22:00:00.000Z" },
    ]);
    const fpA = itineraryFingerprint(offerA);
    const fpB = itineraryFingerprint(offerB);

    // Build the request manually with a cross-boundary protection fact
    // (TripPlanSchema will reject it: "Evidence must identify one unique within-component connection")
    const request = {
      id: "trip-crossboundary",
      jobId: 0,
      bindings: [
        {
          sourceOffer: offerA,
          provider: offerA.provider,
          providerOfferId: offerA.providerOfferId,
          offerId: offerA.id,
          scheduleFingerprint: fpA,
          payment: { kind: "cash", amount: offerA.totalPrice },
          segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
        },
        {
          sourceOffer: offerB,
          provider: offerB.provider,
          providerOfferId: offerB.providerOfferId,
          offerId: offerB.id,
          scheduleFingerprint: fpB,
          payment: { kind: "cash", amount: offerB.totalPrice },
          segments: [{ componentIndex: 1, journeyIndex: 0, segmentIndex: 0 }],
        },
      ],
      journeys: [
        {
          requestedOrigin: "DEL",
          requestedDestination: "LAX",
          segments: [
            { componentIndex: 0, journeyIndex: 0, segmentIndex: 0 },
            { componentIndex: 1, journeyIndex: 0, segmentIndex: 0 },
          ],
        },
      ],
      protection: {
        // Cross-boundary fact: the domain will reject this
        protectionFacts: [
          { journeyIndex: 0, fromSegmentIndex: 0, protection: "protected", reference: "ref-123" },
        ],
        scheduleFingerprint: fpA,
      },
      feasibility: { decisions: [] },
    };
    const outcome = composeTripOption(request);
    expect(outcome.outcome).toBe("declined");
  });

  it("protection evidence is separate_bookings for cross-boundary, never provider", () => {
    const outcome = composeTripOption(twoComponentRequest());
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    const conn = outcome.trip.connections[0];
    expect(conn.evidence.kind).toBe("separate_bookings");
  });
});

// ---------------------------------------------------------------------------
// 3. Feasibility never upgraded and orthogonal to protection
// ---------------------------------------------------------------------------

describe("(3) feasibility never upgraded, orthogonal to protection", () => {
  it("infeasible required connection → declined infeasible_connection", () => {
    const outcome = composeTripOption(
      twoComponentRequest({
        feasibilityDecisions: [
          {
            journeyIndex: 0,
            fromSegmentIndex: 0,
            decision: {
              status: "infeasible",
              gapMinutes: -5,
              reasons: ["negative_gap"],
            },
          },
        ],
      }),
    );
    expect(outcome.outcome).toBe("declined");
    if (outcome.outcome !== "declined") return;
    expect(outcome.reason).toBe("infeasible_connection");
  });

  it("unknown required connection → declined infeasible_connection", () => {
    const outcome = composeTripOption(
      twoComponentRequest({
        feasibilityDecisions: [
          {
            journeyIndex: 0,
            fromSegmentIndex: 0,
            decision: {
              status: "unknown",
              reasons: ["dependency_mismatch"],
            },
          },
        ],
      }),
    );
    expect(outcome.outcome).toBe("declined");
    if (outcome.outcome !== "declined") return;
    expect(outcome.reason).toBe("infeasible_connection");
  });

  it("feasible verdict does NOT raise protection state", () => {
    const outcome = composeTripOption(
      twoComponentRequest({
        feasibilityDecisions: [
          {
            journeyIndex: 0,
            fromSegmentIndex: 0,
            decision: {
              status: "feasible",
              gapMinutes: 120,
              airportRelation: "same_airport",
              splitTicket: true,
              dayRollover: false,
              reasons: ["meets_minimum_connection", "same_airport", "no_day_rollover"],
            },
          },
        ],
      }),
    );
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    // Feasible verdict must NOT upgrade cross-boundary protection from self_transfer
    const conn = outcome.trip.connections[0];
    expect(conn.protection).toBe("self_transfer");
    expect(conn.evidence.kind).toBe("separate_bookings");
  });

  it("no feasibility decision supplied → composed (not gated)", () => {
    const outcome = composeTripOption(twoComponentRequest({ feasibilityDecisions: [] }));
    expect(outcome.outcome).toBe("composed");
  });
});

// ---------------------------------------------------------------------------
// 4. Deterministic + source grep (no Date.now / Math.random / fetch)
// ---------------------------------------------------------------------------

describe("(4) deterministic: same input → same output, no wall-clock or RNG", () => {
  it("two identical calls produce identical results", () => {
    const req = singleComponentRequest();
    const a = composeTripOption(req);
    const b = composeTripOption(req);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("composition.ts source has no Date.now, Math.random, or fetch", () => {
    const text = readFileSync(
      new URL("../packages/composer/src/composition.ts", import.meta.url),
      "utf8",
    );
    expect(text).not.toMatch(/Date\.now\s*\(/);
    expect(text).not.toMatch(/Math\.random\s*\(/);
    expect(text).not.toMatch(/fetch\s*\(/);
  });

  it("all timestamps in output trace to input offer retrievedAt/expiresAt", () => {
    const outcome = composeTripOption(singleComponentRequest());
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    expect(outcome.trip.sourceOffers[0].retrievedAt).toBe(RETRIEVED_AT);
    expect(outcome.trip.sourceOffers[0].expiresAt).toBe(EXPIRES_AT);
  });
});

// ---------------------------------------------------------------------------
// 5. Pure / no-mutation
// ---------------------------------------------------------------------------

describe("(5) pure / no-mutation", () => {
  it("deep-frozen input does not throw and produces composed result", () => {
    const req = singleComponentRequest();
    freezeDeep(req);
    expect(() => composeTripOption(req)).not.toThrow();
    const outcome = composeTripOption(req);
    expect(outcome.outcome).toBe("composed");
  });

  it("does not mutate the input request object", () => {
    const req = singleComponentRequest();
    const snapshot = JSON.stringify(req);
    composeTripOption(req);
    expect(JSON.stringify(req)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 6. Import isolation still passes
// ---------------------------------------------------------------------------

describe("(6) import isolation: composer/src only imports canonical modules", () => {
  it("all files in packages/composer/src import only allowlisted modules", () => {
    const directory = new URL("../packages/composer/src/", import.meta.url);
    for (const file of readdirSync(directory)) {
      const text = readFileSync(new URL(file, directory), "utf8");
      const imports = [
        ...text.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g),
      ].map((match) => match[1]);
      const allowlist = [
        "@flightbrain/domain",
        "./contracts",
        "./execution",
        "./resolution",
        "./feasibility",
        "./ledger",
        "./intake",
        "./protection",
        "./composition",
        "zod",
      ];
      expect(
        imports.every((name) => allowlist.includes(name)),
        `${file} has disallowed import: ${imports.find((n) => !allowlist.includes(n))}`,
      ).toBe(true);
      expect(text).not.toMatch(/Rome2Rio|rome2rio|fetch\s*\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. E4 offers + E5 facts round-trip into createTripOption with no drift
// ---------------------------------------------------------------------------

describe("(7) E4 offers + E5 facts round-trip with no drift", () => {
  it("component fingerprint equals carried value (non-null identity)", () => {
    const offer = makeOffer("offer-del-nrt", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
    ]);
    const fp = itineraryFingerprint(offer);
    const outcome = composeTripOption(singleComponentRequest({ offer, fingerprint: fp }));
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    expect(outcome.trip.bookingComponents[0].scheduleFingerprint).toBe(fp);
  });

  it("null operating identity → null fingerprint", () => {
    const offer = makeOfferNoIdentity("offer-no-identity");
    // Fingerprint for offer with null operating identity must be null
    const fp = itineraryFingerprint(offer);
    expect(fp).toBeNull();
    const outcome = composeTripOption(singleComponentRequest({ offer, fingerprint: null }));
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    expect(outcome.trip.bookingComponents[0].scheduleFingerprint).toBeNull();
  });

  it("offerId/provider/providerOfferId match snapshot", () => {
    const offer = makeOffer("offer-del-nrt", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
    ]);
    const outcome = composeTripOption(singleComponentRequest({ offer }));
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    const comp = outcome.trip.bookingComponents[0];
    expect(comp.offerId).toBe(offer.id);
    expect(comp.provider).toBe(offer.provider);
    expect(comp.providerOfferId).toBe(offer.providerOfferId);
    expect(outcome.trip.sourceOffers[0].id).toBe(offer.id);
    expect(outcome.trip.sourceOffers[0].provider).toBe(offer.provider);
    expect(outcome.trip.sourceOffers[0].providerOfferId).toBe(offer.providerOfferId);
  });
});

// ---------------------------------------------------------------------------
// 8. Mixed protected + self_transfer stays honest
// ---------------------------------------------------------------------------

describe("(8) mixed protected + self_transfer stays honest", () => {
  it("single-ticket protected connection has provider evidence, not separate_bookings", () => {
    // Single offer with two segments — within-component protected connection.
    const offer = makeOffer("offer-del-nrt-lax", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z", carrier: "ZZ", flightNumber: "100" },
      { origin: "NRT", destination: "LAX", departureAt: "2026-10-10T10:00:00.000Z", arrivalAt: "2026-10-10T22:00:00.000Z", carrier: "ZZ", flightNumber: "101" },
    ]);
    const fp = itineraryFingerprint(offer);
    const request = TripCompositionRequestSchema.parse({
      id: "trip-single-protected",
      jobId: 5,
      bindings: [
        {
          sourceOffer: offer,
          provider: offer.provider,
          providerOfferId: offer.providerOfferId,
          offerId: offer.id,
          scheduleFingerprint: fp,
          payment: { kind: "cash", amount: offer.totalPrice },
          segments: [
            { componentIndex: 0, journeyIndex: 0, segmentIndex: 0 },
            { componentIndex: 0, journeyIndex: 0, segmentIndex: 1 },
          ],
        },
      ],
      journeys: [
        {
          requestedOrigin: "DEL",
          requestedDestination: "LAX",
          segments: [
            { componentIndex: 0, journeyIndex: 0, segmentIndex: 0 },
            { componentIndex: 0, journeyIndex: 0, segmentIndex: 1 },
          ],
        },
      ],
      protection: {
        protectionFacts: [
          { journeyIndex: 0, fromSegmentIndex: 0, protection: "protected", reference: "ref-abc" },
        ],
        scheduleFingerprint: fp,
      },
      feasibility: { decisions: [] },
    });
    const outcome = composeTripOption(request);
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    const conn = outcome.trip.connections[0];
    expect(conn.protection).toBe("protected");
    expect(conn.evidence.kind).toBe("provider");
    expect(conn.crossesBookingBoundary).toBe(false);
    expect(outcome.trip.warnings).not.toContain("self_transfer");
  });

  it("self_transfer generates self_transfer warning; no cross-contamination with protected", () => {
    const outcome = composeTripOption(twoComponentRequest());
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    const conn = outcome.trip.connections[0];
    expect(conn.protection).toBe("self_transfer");
    expect(conn.evidence.kind).toBe("separate_bookings");
    expect(outcome.trip.warnings).toContain("self_transfer");
    // No provider evidence should appear for cross-boundary
    expect(outcome.trip.connections.every((c) => !c.crossesBookingBoundary || c.evidence.kind === "separate_bookings")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Decline never fabricate
// ---------------------------------------------------------------------------

describe("(9) decline never fabricate", () => {
  it("no_offer_for_job: mismatched offerId triggers decline", () => {
    const offer = makeOffer("offer-del-nrt", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
    ]);
    const fp = itineraryFingerprint(offer);
    // Provide wrong offerId to cause provenance mismatch
    const outcome = composeTripOption({
      id: "trip-mismatch",
      jobId: 0,
      bindings: [
        {
          sourceOffer: offer,
          provider: offer.provider,
          providerOfferId: offer.providerOfferId,
          offerId: "wrong-offer-id",  // mismatch
          scheduleFingerprint: fp,
          payment: { kind: "cash", amount: offer.totalPrice },
          segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
        },
      ],
      journeys: [
        {
          requestedOrigin: "DEL",
          requestedDestination: "NRT",
          segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
        },
      ],
      protection: { protectionFacts: [], scheduleFingerprint: fp },
      feasibility: { decisions: [] },
    });
    expect(outcome.outcome).toBe("declined");
  });

  it("incomplete_route_coverage: mismatched requestedDestination triggers decline", () => {
    const offer = makeOffer("offer-del-nrt", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
    ]);
    const fp = itineraryFingerprint(offer);
    // requestedDestination doesn't match actual last segment destination
    const outcome = composeTripOption({
      id: "trip-incomplete",
      jobId: 0,
      bindings: [
        {
          sourceOffer: offer,
          provider: offer.provider,
          providerOfferId: offer.providerOfferId,
          offerId: offer.id,
          scheduleFingerprint: fp,
          payment: { kind: "cash", amount: offer.totalPrice },
          segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
        },
      ],
      journeys: [
        {
          requestedOrigin: "DEL",
          requestedDestination: "LAX",  // wrong — actual is NRT
          segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
        },
      ],
      protection: { protectionFacts: [], scheduleFingerprint: fp },
      feasibility: { decisions: [] },
    });
    expect(outcome.outcome).toBe("declined");
    if (outcome.outcome !== "declined") return;
    expect(outcome.reason).toBe("incomplete_route_coverage");
  });
});

// ---------------------------------------------------------------------------
// 10. Batch fold invariants
// ---------------------------------------------------------------------------

describe("(10) batch fold invariants", () => {
  it("requestId is preserved in result", () => {
    const req = singleComponentRequest({ jobId: 0 });
    const result = composeTripOptions("req-abc-123", [req]);
    expect(result.requestId).toBe("req-abc-123");
  });

  it("job order is preserved in outcomes array", () => {
    const req0 = singleComponentRequest({ jobId: 0, id: "trip-a" });
    const req1 = singleComponentRequest({ jobId: 1, id: "trip-b" });
    const result = composeTripOptions("req-order", [req0, req1]);
    expect(result.outcomes[0].jobId).toBe(0);
    expect(result.outcomes[1].jobId).toBe(1);
  });

  it("composedJobIds invariant: matches composed outcomes' jobIds in order", () => {
    const req0 = singleComponentRequest({ jobId: 0, id: "trip-c" });
    const req1 = singleComponentRequest({ jobId: 1, id: "trip-d" });
    const result = composeTripOptions("req-invariant", [req0, req1]);
    const fromOutcomes = result.outcomes
      .filter((o) => o.outcome === "composed")
      .map((o) => o.jobId);
    expect(result.composedJobIds).toEqual(fromOutcomes);
    expect(() => TripCompositionResultSchema.parse(result)).not.toThrow();
  });

  it("composedJobIds invariant violation rejected by schema", () => {
    const result: TripCompositionResult = composeTripOptions("req-corrupt", [
      singleComponentRequest({ jobId: 0, id: "trip-e" }),
    ]);
    // Corrupt the invariant
    const corrupt = { ...result, composedJobIds: [99] };
    expect(TripCompositionResultSchema.safeParse(corrupt).success).toBe(false);
  });

  it("diagnostics deduplicate first-seen decline reasons", () => {
    const offerA = makeOffer("offer-del-nrt-a", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
    ]);
    const fpA = itineraryFingerprint(offerA);
    // Two requests both with wrong requestedDestination → both decline with incomplete_route_coverage
    const badReq0 = {
      id: "trip-bad-0",
      jobId: 0,
      bindings: [
        {
          sourceOffer: offerA,
          provider: offerA.provider,
          providerOfferId: offerA.providerOfferId,
          offerId: offerA.id,
          scheduleFingerprint: fpA,
          payment: { kind: "cash", amount: offerA.totalPrice },
          segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
        },
      ],
      journeys: [
        {
          requestedOrigin: "DEL",
          requestedDestination: "LAX",
          segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
        },
      ],
      protection: { protectionFacts: [], scheduleFingerprint: fpA },
      feasibility: { decisions: [] },
    };
    const offerB = makeOffer("offer-del-nrt-b", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-11T00:00:00.000Z", arrivalAt: "2026-10-11T08:00:00.000Z" },
    ]);
    const fpB = itineraryFingerprint(offerB);
    const badReq1 = {
      id: "trip-bad-1",
      jobId: 1,
      bindings: [
        {
          sourceOffer: offerB,
          provider: offerB.provider,
          providerOfferId: offerB.providerOfferId,
          offerId: offerB.id,
          scheduleFingerprint: fpB,
          payment: { kind: "cash", amount: offerB.totalPrice },
          segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
        },
      ],
      journeys: [
        {
          requestedOrigin: "DEL",
          requestedDestination: "LAX",
          segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
        },
      ],
      protection: { protectionFacts: [], scheduleFingerprint: fpB },
      feasibility: { decisions: [] },
    };
    const result = composeTripOptions("req-diag", [badReq0, badReq1]);
    // Both decline with same reason → only one diagnostic entry
    expect(result.diagnostics.filter((d) => d === "incomplete_route_coverage")).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Composes, does NOT rank
// ---------------------------------------------------------------------------

describe("(11) composes-not-ranks: no score/ordering field; order follows input", () => {
  it("TripOption has no score/rank/quality/pareto field", () => {
    const outcome = composeTripOption(singleComponentRequest());
    expect(outcome.outcome).toBe("composed");
    if (outcome.outcome !== "composed") return;
    expect(outcome.trip).not.toHaveProperty("score");
    expect(outcome.trip).not.toHaveProperty("rank");
    expect(outcome.trip).not.toHaveProperty("quality");
    expect(outcome.trip).not.toHaveProperty("pareto");
    expect(outcome.trip).not.toHaveProperty("ranking");
  });

  it("batch result preserves input order, does not sort by any criterion", () => {
    // Create two offers where the second is cheaper — if it ranked by price it would reorder.
    const offerExpensive = makeOffer("offer-expensive", [
      { origin: "DEL", destination: "NRT", departureAt: "2026-10-10T00:00:00.000Z", arrivalAt: "2026-10-10T08:00:00.000Z" },
    ]);
    const offerCheap = FlightOfferSchema.parse({
      ...offerExpensive,
      id: "offer-cheap",
      providerOfferId: "source-offer-cheap",
      totalPrice: { amountMinor: "10000", currency: "USD", exponent: 2 },
      providerMetadata: { synthetic: true, cheaper: true },
    });
    const req0 = singleComponentRequest({ jobId: 0, id: "trip-expensive", offer: offerExpensive, fingerprint: itineraryFingerprint(offerExpensive) });
    const req1 = singleComponentRequest({ jobId: 1, id: "trip-cheap", offer: offerCheap, fingerprint: itineraryFingerprint(offerCheap) });
    const result = composeTripOptions("req-order-check", [req0, req1]);
    // Order must follow input: job 0 first, job 1 second
    expect(result.outcomes[0].jobId).toBe(0);
    expect(result.outcomes[1].jobId).toBe(1);
    // No sorting by price
    expect(result.composedJobIds).toEqual([0, 1]);
  });

  it("TripCompositionResult has no score/rank field", () => {
    const result = composeTripOptions("req-no-rank", [singleComponentRequest()]);
    expect(result).not.toHaveProperty("score");
    expect(result).not.toHaveProperty("rank");
  });
});
