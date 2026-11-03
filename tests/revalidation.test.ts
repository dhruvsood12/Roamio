/**
 * C009 revalidation tests — 13 acceptance criteria.
 *
 * All tests use injected asOf (never Date.now()), offline discovery, and E4 mock port.
 * Synthetic data only — no real fares, carriers, or routes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleSearch, defaultSearchApiDeps } from "@flightbrain/search-api";
import {
  deferredRealProviderIntakePort,
  RealProviderNotImplementedError,
  mockProviderIntakePort,
  itineraryFingerprint,
} from "@flightbrain/orchestrator";
import { FlightOfferSchema, TripOptionSchema } from "@flightbrain/domain";
import { tripStaleness } from "@flightbrain/ranking";
import {
  composeTripOption,
  TripCompositionRequestSchema,
} from "@flightbrain/composer";
import {
  revalidateSearch,
  classifyTripFreshness,
  stableTripKey,
  type PriorResult,
  type RevalidationPolicy,
} from "@flightbrain/revalidation";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const FIXED_AS_OF = "2026-01-15T12:00:00Z";

const BASE_REQUEST = {
  origins: ["LHR"] as [string, ...string[]],
  destinations: ["JFK"] as [string, ...string[]],
  departureDate: "2026-03-01",
  adults: 1,
  cabins: ["economy" as const] as ["economy"],
  maxStops: null,
  currency: "USD" as const,
};

async function makeFixture(asOf = FIXED_AS_OF) {
  return handleSearch(BASE_REQUEST, { asOf });
}

/** Build a PriorResult from a search response */
function makePrior(response: Awaited<ReturnType<typeof makeFixture>>): PriorResult {
  return { priorResponse: response, request: BASE_REQUEST };
}

/** Default refetch_always policy */
const defaultPolicy: RevalidationPolicy = {
  asOf: FIXED_AS_OF,
  refetchMode: "refetch_always",
};

// ---------------------------------------------------------------------------
// 1. Determinism
// ---------------------------------------------------------------------------

describe("1. determinism", () => {
  it("two calls with same prior+deps (all-fresh) produce deep-equal results", async () => {
    // Use a past asOf so offers (1h validity from FIXED_AS_OF) haven't expired
    const freshAsOf = "2026-01-14T00:00:00Z";
    const response = await makeFixture(freshAsOf);
    const prior = makePrior(response);
    const policy: RevalidationPolicy = { asOf: freshAsOf, refetchMode: "refetch_always" };

    const r1 = await revalidateSearch(prior, { asOf: freshAsOf, policy });
    const r2 = await revalidateSearch(prior, { asOf: freshAsOf, policy });

    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// 2. Source-scan: no forbidden globals
// ---------------------------------------------------------------------------

describe("2. source-scan no forbidden globals", () => {
  it("revalidate.ts must not contain Date.now, Math.random, new Date() without args, or fetch(", () => {
    const sourceUrl = new URL(
      "../packages/revalidation/src/revalidate.ts",
      import.meta.url,
    );
    const source = readFileSync(fileURLToPath(sourceUrl), "utf-8");

    expect(source).not.toMatch(/Date\.now\(\)/);
    expect(source).not.toMatch(/Math\.random\(\)/);
    // new Date() without args (allow new Date( with args)
    expect(source).not.toMatch(/new Date\(\)/);
    expect(source).not.toMatch(/\bfetch\(/);
  });
});

// ---------------------------------------------------------------------------
// 3. FRESH not re-fetched — port never called
// ---------------------------------------------------------------------------

describe("3. fresh trips: port never called", () => {
  it("when all trips are fresh, port.intake is never invoked", async () => {
    // The mock always generates requiresRevalidation=true offers, so we must
    // manufacture a prior response with truly fresh trips (requiresRevalidation=false,
    // expiresAt far in the future).
    const fixtureAsOf = "2026-01-14T00:00:00Z";
    const checkAsOf = "2026-01-14T06:00:00Z"; // well before expiresAt
    const response = await makeFixture(fixtureAsOf);
    expect(response.trips.length).toBeGreaterThan(0);

    // Manufacture fresh trips: set requiresRevalidation=false and far-future expiresAt
    const freshTrips = response.trips.map((rt) => ({
      ...rt,
      trip: TripOptionSchema.parse({
        ...rt.trip,
        sourceOffers: rt.trip.sourceOffers.map((so) => ({
          ...so,
          requiresRevalidation: false,
          expiresAt: "2030-01-01T00:00:00Z",
        })),
      }),
      freshness: {
        ...rt.freshness,
        requiresRevalidation: false,
        nearestExpiresAt: "2030-01-01T00:00:00Z",
      },
    }));
    const freshResponse = { ...response, trips: freshTrips };

    // Inject a port that throws if called
    const neverCallPort = {
      async intake(_descriptor: unknown, _context: unknown): Promise<never> {
        throw new Error("Port.intake must NOT be called for fresh trips");
      },
    };

    const prior: PriorResult = { priorResponse: freshResponse, request: BASE_REQUEST };
    const policy: RevalidationPolicy = { asOf: checkAsOf, refetchMode: "refetch_always" };

    const result = await revalidateSearch(prior, {
      asOf: checkAsOf,
      port: neverCallPort as Parameters<typeof revalidateSearch>[1]["port"],
      policy,
    });

    expect(result.refetched).toBe(false);
    expect(result.diff.skippedCount).toBe(freshTrips.length);
    expect(result.diff.refetchedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Expired at inclusive boundary
// ---------------------------------------------------------------------------

describe("4. expired at inclusive boundary", () => {
  // Use an earlier fixture asOf so retrievedAt < BOUNDARY_AS_OF (constraint: expiresAt > retrievedAt)
  const EARLY_AS_OF = "2026-01-14T10:00:00Z";
  const BOUNDARY_AS_OF = "2026-01-15T12:00:00Z";

  it("expiresAt === asOf → expired (inclusive)", async () => {
    const response = await makeFixture(EARLY_AS_OF);
    if (response.trips.length === 0) return;

    const realTrip = response.trips[0].trip;
    const asOfMs = Date.parse(BOUNDARY_AS_OF);
    const boundaryPolicy: RevalidationPolicy = { asOf: BOUNDARY_AS_OF, refetchMode: "refetch_always" };

    // expiresAt = BOUNDARY_AS_OF; retrievedAt = EARLY_AS_OF (valid: expiresAt > retrievedAt)
    const tripAtBoundary = TripOptionSchema.parse({
      ...realTrip,
      sourceOffers: realTrip.sourceOffers.map((so, i) =>
        i === 0 ? { ...so, expiresAt: BOUNDARY_AS_OF } : so
      ),
    });

    const freshness = classifyTripFreshness(tripAtBoundary, asOfMs, boundaryPolicy);
    expect(freshness).toBe("expired");
  });

  it("expiresAt === asOf + 1ms → fresh", async () => {
    const response = await makeFixture(EARLY_AS_OF);
    if (response.trips.length === 0) return;

    const realTrip = response.trips[0].trip;
    const asOfMs = Date.parse(BOUNDARY_AS_OF);
    const boundaryPolicy: RevalidationPolicy = { asOf: BOUNDARY_AS_OF, refetchMode: "refetch_always" };
    // 1ms after BOUNDARY_AS_OF; also set requiresRevalidation=false so only expiresAt governs freshness
    const oneAfter = new Date(asOfMs + 1).toISOString();

    const tripJustAfter = TripOptionSchema.parse({
      ...realTrip,
      sourceOffers: realTrip.sourceOffers.map((so, i) =>
        i === 0 ? { ...so, expiresAt: oneAfter, requiresRevalidation: false } : so
      ),
    });

    const freshness = classifyTripFreshness(tripJustAfter, asOfMs, boundaryPolicy);
    expect(freshness).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// 5. requiresRevalidation triggers refetch (per refetchMode)
// ---------------------------------------------------------------------------

describe("5. requiresRevalidation triggers refetch based on refetchMode", () => {
  it("refetch_always: requiresRevalidation=true but far-future expiresAt → refetched=true", async () => {
    const response = await makeFixture(FIXED_AS_OF);
    if (response.trips.length === 0) return;

    const realTrip = response.trips[0].trip;
    // Set requiresRevalidation=true, expiresAt far in the future
    const tripReval = TripOptionSchema.parse({
      ...realTrip,
      sourceOffers: realTrip.sourceOffers.map((so, i) =>
        i === 0
          ? { ...so, requiresRevalidation: true, expiresAt: "2030-01-01T00:00:00Z" }
          : so
      ),
    });

    // Build a fake prior with this modified trip
    const fakePriorResponse = {
      ...response,
      trips: [
        {
          ...response.trips[0],
          trip: tripReval,
          freshness: {
            ...response.trips[0].freshness,
            requiresRevalidation: true,
            nearestExpiresAt: "2030-01-01T00:00:00Z",
          },
        },
      ],
    };
    const prior: PriorResult = { priorResponse: fakePriorResponse, request: BASE_REQUEST };
    const policy: RevalidationPolicy = { asOf: FIXED_AS_OF, refetchMode: "refetch_always" };

    const result = await revalidateSearch(prior, { asOf: FIXED_AS_OF, policy });
    expect(result.refetched).toBe(true);
  });

  it("only_when_expired: requiresRevalidation=true but not expired → refetched=false", async () => {
    const response = await makeFixture(FIXED_AS_OF);
    if (response.trips.length === 0) return;

    const realTrip = response.trips[0].trip;
    const tripReval = TripOptionSchema.parse({
      ...realTrip,
      sourceOffers: realTrip.sourceOffers.map((so, i) =>
        i === 0
          ? { ...so, requiresRevalidation: true, expiresAt: "2030-01-01T00:00:00Z" }
          : so
      ),
    });

    const fakePriorResponse = {
      ...response,
      trips: [
        {
          ...response.trips[0],
          trip: tripReval,
          freshness: {
            ...response.trips[0].freshness,
            requiresRevalidation: true,
            nearestExpiresAt: "2030-01-01T00:00:00Z",
          },
        },
      ],
    };
    const prior: PriorResult = { priorResponse: fakePriorResponse, request: BASE_REQUEST };
    const policy: RevalidationPolicy = { asOf: FIXED_AS_OF, refetchMode: "only_when_expired" };

    const result = await revalidateSearch(prior, { asOf: FIXED_AS_OF, policy });
    expect(result.refetched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Re-run uses injected port offline + deferredRealProviderIntakePort throws
// ---------------------------------------------------------------------------

describe("6. re-run uses injected port", () => {
  it("valid mock port → refetched=true (the injected offline seam is used)", async () => {
    // Use expired asOf so trips are stale
    const earlyAsOf = "2020-01-01T00:00:00Z"; // well before expiry
    const expiredAsOf = "2030-01-01T00:00:00Z"; // well after expiry
    const response = await makeFixture(earlyAsOf);
    if (response.trips.length === 0) return;

    const prior = makePrior(response);
    const policy: RevalidationPolicy = { asOf: expiredAsOf, refetchMode: "refetch_always" };

    // Inject a valid offline mock port
    const mockPort = mockProviderIntakePort(
      { asOf: expiredAsOf, seed: 42, offersPerDescriptor: 2, offerValidityMs: 3_600_000, currency: "USD" },
      { providerId: "mock:test", synthetic: true, disclaimer: "SYNTHETIC" },
    );

    const result = await revalidateSearch(prior, {
      asOf: expiredAsOf,
      port: mockPort,
      policy,
    });

    expect(result.refetched).toBe(true);
  });

  it("deferredRealProviderIntakePort throws RealProviderNotImplementedError when invoked via revalidateSearch", async () => {
    const earlyAsOf = "2020-01-01T00:00:00Z";
    const expiredAsOf = "2030-01-01T00:00:00Z";
    const response = await makeFixture(earlyAsOf);
    if (response.trips.length === 0) return;

    const prior = makePrior(response);
    const policy: RevalidationPolicy = { asOf: expiredAsOf, refetchMode: "refetch_always" };

    await expect(
      revalidateSearch(prior, {
        asOf: expiredAsOf,
        port: deferredRealProviderIntakePort,
        policy,
      }),
    ).rejects.toBeInstanceOf(RealProviderNotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// 7. Every diff category is field-attributable (derivedFrom non-empty)
// ---------------------------------------------------------------------------

describe("7. every diff category has derivedFrom entry", () => {
  it("all TripChanges have non-empty derivedFrom when categories is non-empty", async () => {
    const earlyAsOf = "2020-01-01T00:00:00Z";
    const expiredAsOf = "2030-01-01T00:00:00Z";
    const response = await makeFixture(earlyAsOf);
    const prior = makePrior(response);
    const policy: RevalidationPolicy = { asOf: expiredAsOf, refetchMode: "refetch_always" };

    const result = await revalidateSearch(prior, { asOf: expiredAsOf, policy });

    for (const change of result.diff.changes) {
      if (change.categories.length > 0) {
        expect(change.derivedFrom.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Nothing-invented property
// ---------------------------------------------------------------------------

describe("8. nothing-invented: no category without field delta derivedFrom", () => {
  it("every non-empty categories array has matching derivedFrom", async () => {
    const earlyAsOf = "2020-01-01T00:00:00Z";
    const expiredAsOf = "2030-01-01T00:00:00Z";
    const response = await makeFixture(earlyAsOf);
    const prior = makePrior(response);
    const policy: RevalidationPolicy = { asOf: expiredAsOf, refetchMode: "refetch_always" };

    const result = await revalidateSearch(prior, { asOf: expiredAsOf, policy });

    for (const change of result.diff.changes) {
      // No change should have categories but empty derivedFrom
      expect(change.categories.length === 0 || change.derivedFrom.length > 0).toBe(true);
    }

    // All-fresh scenario too
    const freshPolicy: RevalidationPolicy = { asOf: earlyAsOf, refetchMode: "refetch_always" };
    const freshResult = await revalidateSearch(makePrior(response), { asOf: earlyAsOf, policy: freshPolicy });
    for (const change of freshResult.diff.changes) {
      expect(change.categories.length === 0 || change.derivedFrom.length > 0).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. unknown stays unknown
// ---------------------------------------------------------------------------

describe("9. unknown stays unknown", () => {
  it("trip with no expiresAt and requiresRevalidation=false → unknown", async () => {
    const response = await makeFixture(FIXED_AS_OF);
    if (response.trips.length === 0) return;

    const realTrip = response.trips[0].trip;
    const asOfMs = Date.parse(FIXED_AS_OF);

    // Set all sourceOffers: expiresAt=null, requiresRevalidation=false
    const unknownTrip = TripOptionSchema.parse({
      ...realTrip,
      sourceOffers: realTrip.sourceOffers.map((so) => ({
        ...so,
        expiresAt: null,
        requiresRevalidation: false,
      })),
    });

    const freshness = classifyTripFreshness(unknownTrip, asOfMs, defaultPolicy);
    expect(freshness).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 10. Mixed-currency honesty
// ---------------------------------------------------------------------------

describe("10. mixed-currency honesty", () => {
  it("prior USD trips + re-run with EUR port: no price_changed, mixed_currency_incomparable diagnostic", async () => {
    const earlyAsOf = "2020-01-01T00:00:00Z";
    const expiredAsOf = "2030-01-01T00:00:00Z";
    const response = await makeFixture(earlyAsOf);
    if (response.trips.length === 0) return;

    const prior = makePrior(response);
    const policy: RevalidationPolicy = { asOf: expiredAsOf, refetchMode: "refetch_always" };

    // Inject a port that returns EUR offers
    const eurPort = mockProviderIntakePort(
      { asOf: expiredAsOf, seed: 99, offersPerDescriptor: 2, offerValidityMs: 3_600_000, currency: "EUR" },
      { providerId: "mock:eur", synthetic: true, disclaimer: "SYNTHETIC EUR" },
    );

    const result = await revalidateSearch(prior, {
      asOf: expiredAsOf,
      port: eurPort,
      policy,
    });

    // No price_changed when currencies differ
    for (const change of result.diff.changes) {
      expect(change.categories).not.toContain("price_changed");
    }

    // mixed_currency_incomparable diagnostic present
    expect(result.diagnostics).toContain("mixed_currency_incomparable");
  });
});

// ---------------------------------------------------------------------------
// 11. classifyTripFreshness agrees with tripStaleness
// ---------------------------------------------------------------------------

describe("11. classifyTripFreshness agrees with tripStaleness", () => {
  it("battery: rank=0 → fresh or unknown; rank=1 → expired or requires_revalidation", async () => {
    // Use an earlier asOf so retrievedAt < FIXED_AS_OF, allowing expiresAt=FIXED_AS_OF to be valid
    const EARLY_FIXTURE_AS_OF = "2026-01-14T10:00:00Z";
    const BOUNDARY_AS_OF = "2026-01-15T12:00:00Z"; // asOfMs for the boundary test
    const boundaryAsOfMs = Date.parse(BOUNDARY_AS_OF);
    const boundaryPolicy: RevalidationPolicy = { asOf: BOUNDARY_AS_OF, refetchMode: "refetch_always" };

    const response = await makeFixture(EARLY_FIXTURE_AS_OF);
    if (response.trips.length === 0) return;

    const realTrip = response.trips[0].trip;
    // retrievedAt should be EARLY_FIXTURE_AS_OF, so BOUNDARY_AS_OF is a valid expiresAt

    // Case A: fresh trip (expiresAt far future)
    const freshTrip = TripOptionSchema.parse({
      ...realTrip,
      sourceOffers: realTrip.sourceOffers.map((so) => ({
        ...so,
        expiresAt: "2030-01-01T00:00:00Z",
        requiresRevalidation: false,
      })),
    });
    const freshStaleness = tripStaleness(freshTrip, boundaryAsOfMs);
    const freshFreshness = classifyTripFreshness(freshTrip, boundaryAsOfMs, boundaryPolicy);
    expect(freshStaleness.rank).toBe(0);
    expect(["fresh", "unknown"]).toContain(freshFreshness);

    // Case B: expired exactly at boundary (expiresAt = BOUNDARY_AS_OF, retrievedAt = EARLY_FIXTURE_AS_OF)
    const expiredTrip = TripOptionSchema.parse({
      ...realTrip,
      sourceOffers: realTrip.sourceOffers.map((so, i) =>
        i === 0 ? { ...so, expiresAt: BOUNDARY_AS_OF, requiresRevalidation: false } : so
      ),
    });
    const expiredStaleness = tripStaleness(expiredTrip, boundaryAsOfMs);
    const expiredFreshness = classifyTripFreshness(expiredTrip, boundaryAsOfMs, boundaryPolicy);
    expect(expiredStaleness.rank).toBe(1);
    expect(expiredFreshness).toBe("expired");

    // Case C: expired well past boundary
    const pastExpiredTrip = TripOptionSchema.parse({
      ...realTrip,
      sourceOffers: realTrip.sourceOffers.map((so, i) =>
        // expiresAt must be after retrievedAt (EARLY_FIXTURE_AS_OF) but before BOUNDARY_AS_OF
        i === 0 ? { ...so, expiresAt: "2026-01-14T11:00:00Z", requiresRevalidation: false } : so
      ),
    });
    const pastStaleness = tripStaleness(pastExpiredTrip, boundaryAsOfMs);
    const pastFreshness = classifyTripFreshness(pastExpiredTrip, boundaryAsOfMs, boundaryPolicy);
    expect(pastStaleness.rank).toBe(1);
    expect(pastFreshness).toBe("expired");

    // Case D: requiresRevalidation=true, far-future expiresAt
    const revalTrip = TripOptionSchema.parse({
      ...realTrip,
      sourceOffers: realTrip.sourceOffers.map((so, i) =>
        i === 0 ? { ...so, requiresRevalidation: true, expiresAt: "2030-01-01T00:00:00Z" } : so
      ),
    });
    const revalStaleness = tripStaleness(revalTrip, boundaryAsOfMs);
    const revalFreshness = classifyTripFreshness(revalTrip, boundaryAsOfMs, boundaryPolicy);
    expect(revalStaleness.rank).toBe(1);
    expect(revalFreshness).toBe("requires_revalidation");
  });
});

// ---------------------------------------------------------------------------
// 12. Empty/degenerate: prior with zero trips
// ---------------------------------------------------------------------------

describe("12. empty/degenerate", () => {
  it("prior with zero trips returns without throwing, empty diff, refetched=false", async () => {
    const response = await makeFixture(FIXED_AS_OF);
    // Manufacture an empty-trips response
    const emptyResponse = {
      ...response,
      trips: [],
      coverage: {
        ...response.coverage,
        tripsComposed: 0,
        tripsRanked: 0,
      },
      diagnostics: {
        ...response.diagnostics,
      },
    };

    const prior: PriorResult = { priorResponse: emptyResponse, request: BASE_REQUEST };
    const policy: RevalidationPolicy = { asOf: FIXED_AS_OF, refetchMode: "refetch_always" };

    const result = await revalidateSearch(prior, { asOf: FIXED_AS_OF, policy });

    expect(result.diff.changes).toHaveLength(0);
    expect(result.refetched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. Revalidation gate proof: deferredRealProviderIntakePort throws
// ---------------------------------------------------------------------------

describe("13. revalidation gate proof (C006 seam)", () => {
  it("deferredRealProviderIntakePort.intake throws RealProviderNotImplementedError directly", async () => {
    // Directly call the deferred port to prove the seam is gated
    const fakeDescriptor = {} as Parameters<typeof deferredRealProviderIntakePort.intake>[0];
    const fakeContext = { asOf: FIXED_AS_OF } as Parameters<typeof deferredRealProviderIntakePort.intake>[1];

    await expect(
      deferredRealProviderIntakePort.intake(fakeDescriptor, fakeContext),
    ).rejects.toBeInstanceOf(RealProviderNotImplementedError);
  });

  it("RealProviderNotImplementedError has the expected name", async () => {
    try {
      await deferredRealProviderIntakePort.intake(
        {} as Parameters<typeof deferredRealProviderIntakePort.intake>[0],
        { asOf: FIXED_AS_OF } as Parameters<typeof deferredRealProviderIntakePort.intake>[1],
      );
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RealProviderNotImplementedError);
      expect((err as RealProviderNotImplementedError).name).toBe("RealProviderNotImplementedError");
    }
  });
});

// ---------------------------------------------------------------------------
// Bonus: stableTripKey uses scheduleFingerprint when available
// ---------------------------------------------------------------------------

describe("stableTripKey", () => {
  it("two calls with the same trip return the same key", async () => {
    const response = await makeFixture(FIXED_AS_OF);
    if (response.trips.length === 0) return;

    const trip = response.trips[0].trip;
    expect(stableTripKey(trip)).toBe(stableTripKey(trip));
  });

  it("key uses sched: content prefix (not fp:null::trip.id) when scheduleFingerprint is null", async () => {
    const response = await makeFixture(FIXED_AS_OF);
    if (response.trips.length === 0) return;

    const trip = response.trips[0].trip;
    // scheduleFingerprint is already null on synthetic data (operatingCarrier/operatingFlightNumber=null)
    // so stableTripKey should produce a sched: content key, NOT fp:null::trip.id
    const key = stableTripKey(trip);
    expect(key.startsWith("sched:")).toBe(true);
    // key must NOT embed the volatile trip.id
    expect(key).not.toContain(trip.id);
  });
});

// ---------------------------------------------------------------------------
// 14. Non-null fingerprint path: stableTripKey uses fb:schedule:v1: branch
// ---------------------------------------------------------------------------

/** Build a minimal FlightOffer with real operating identity (fingerprint-able). */
function makeOfferWithOperatingIdentity(id: string): import("@flightbrain/domain").FlightOffer {
  return FlightOfferSchema.parse({
    id,
    journeys: [
      {
        segments: [
          {
            origin: "LHR",
            destination: "JFK",
            departureAt: "2026-03-01T10:00:00.000Z",
            arrivalAt: "2026-03-01T18:00:00.000Z",
            marketingCarrier: "BA",
            marketingFlightNumber: "117",
            operatingCarrier: "BA",
            operatingFlightNumber: "117",
            cabin: "economy",
          },
        ],
      },
    ],
    provider: "mock:test",
    providerOfferId: `src-${id}`,
    bookingUrl: null,
    retrievedAt: "2026-01-15T12:00:00.000Z",
    expiresAt: "2026-01-15T13:00:00.000Z",
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

/** Build a TripCompositionRequest for the given offer (single-segment, single-component). */
function makeCompositionRequest(
  tripId: string,
  offer: import("@flightbrain/domain").FlightOffer,
): import("@flightbrain/composer").TripCompositionRequest {
  const fp = itineraryFingerprint(offer);
  return TripCompositionRequestSchema.parse({
    id: tripId,
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
        requestedOrigin: "LHR",
        requestedDestination: "JFK",
        segments: [{ componentIndex: 0, journeyIndex: 0, segmentIndex: 0 }],
      },
    ],
    protection: { protectionFacts: [], scheduleFingerprint: fp },
    feasibility: { decisions: [] },
  });
}

describe("14. non-null fingerprint path: stableTripKey uses fingerprint branch", () => {
  it("trip with operating identity produces fb:schedule:v1: key (not sched:)", () => {
    const offer = makeOfferWithOperatingIdentity("offer-lhr-jfk");
    const fp = itineraryFingerprint(offer);
    // Fingerprint must be non-null when operating identity is present
    expect(fp).not.toBeNull();
    expect(fp).toMatch(/^fb:schedule:v1:/);

    const result = composeTripOption(makeCompositionRequest("trip-fp-test", offer));
    expect(result.outcome).toBe("composed");
    if (result.outcome !== "composed") return;

    const trip = result.trip;
    expect(trip.bookingComponents[0].scheduleFingerprint).toBe(fp);

    const key = stableTripKey(trip);
    // Key must use the fingerprint path (starts with fb:schedule:v1:)
    expect(key).toMatch(/^fb:schedule:v1:/);
    // Key must NOT start with sched:
    expect(key.startsWith("sched:")).toBe(false);
    // Key must embed the fingerprint value
    expect(key).toContain(fp!);
  });

  it("two constructions of the same schedule produce identical fingerprint-based keys", () => {
    // Build the same offer twice with different IDs — same schedule → same fingerprint → same key
    const offer1 = makeOfferWithOperatingIdentity("offer-lhr-jfk-a");
    const offer2 = makeOfferWithOperatingIdentity("offer-lhr-jfk-b");

    const result1 = composeTripOption(makeCompositionRequest("trip-fp-1", offer1));
    const result2 = composeTripOption(makeCompositionRequest("trip-fp-2", offer2));

    expect(result1.outcome).toBe("composed");
    expect(result2.outcome).toBe("composed");
    if (result1.outcome !== "composed" || result2.outcome !== "composed") return;

    const key1 = stableTripKey(result1.trip);
    const key2 = stableTripKey(result2.trip);

    expect(key1).toMatch(/^fb:schedule:v1:/);
    // Different trip IDs, same schedule → same key
    expect(result1.trip.id).not.toBe(result2.trip.id);
    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// 15. Content-fallback stable across id churn
// ---------------------------------------------------------------------------

describe("15. content-fallback stable across id churn", () => {
  it("same schedule, different trip.id → identical stableTripKey (not volatile)", async () => {
    // On synthetic data, all trips have null fingerprint → sched: key path.
    // If we simulate a re-run where the same schedule arrives under a different trip.id,
    // stableTripKey must still match them as the same trip.
    const response = await makeFixture(FIXED_AS_OF);
    if (response.trips.length === 0) return;

    const trip = response.trips[0].trip;
    expect(trip.bookingComponents[0].scheduleFingerprint).toBeNull();

    // Simulate id churn: same trip but different id (as would happen across mock re-runs)
    const churned = TripOptionSchema.parse({ ...trip, id: "trip:job:999:offer:volatile-different-id" });

    const keyOriginal = stableTripKey(trip);
    const keyChurned = stableTripKey(churned);

    // Both keys must be content-based (sched: prefix)
    expect(keyOriginal.startsWith("sched:")).toBe(true);
    expect(keyChurned.startsWith("sched:")).toBe(true);

    // Keys must be identical regardless of trip.id
    expect(keyOriginal).toBe(keyChurned);

    // Also verify the key does NOT contain the volatile trip.id
    expect(keyOriginal).not.toContain(trip.id);
    expect(keyChurned).not.toContain(churned.id);
  });

  it("revalidateSearch with same-schedule/different-price port: price_changed not turnover", async () => {
    // This is the core correctness test: if a re-run yields the same schedule at a
    // different price, the diff must be price_changed (or unchanged), NOT
    // became_unavailable + became_available (which would indicate id-based matching failure).
    const earlyAsOf = "2020-01-01T00:00:00Z";
    const expiredAsOf = "2030-01-01T00:00:00Z";
    const priorResponse = await makeFixture(earlyAsOf);
    if (priorResponse.trips.length === 0) return;

    const prior = makePrior(priorResponse);
    const policy: RevalidationPolicy = { asOf: expiredAsOf, refetchMode: "refetch_always" };

    // Build a port that returns the same offers as the default mock (seed=42) but with doubled prices.
    // This keeps the schedule (segments/times/carriers) identical → same stableTripKey.
    // We wrap the base mock port (same seed=42 as defaultSearchApiDeps) and scale totalPrice.amountMinor.
    const baseMockPort = mockProviderIntakePort(
      { asOf: earlyAsOf, seed: 42, offersPerDescriptor: 2, offerValidityMs: 3_600_000, currency: "USD" },
      { providerId: "mock:search-api", synthetic: true, disclaimer: "SYNTHETIC DATA — offline default; no real fares or carriers." },
    );
    const pricedHigherPort: typeof baseMockPort = {
      async intake(descriptor, context) {
        const outcome = await baseMockPort.intake(descriptor, context);
        if (outcome.outcome !== "offered") return outcome;
        // Scale each offer's price 2× (keeping same schedule/segments).
        const scaledOffers = outcome.offers.map((raw) => {
          const offer = FlightOfferSchema.parse(raw);
          const scaled = BigInt(offer.totalPrice.amountMinor) * 2n;
          return FlightOfferSchema.parse({
            ...offer,
            id: offer.id + "-repriced",
            providerOfferId: offer.providerOfferId + "-repriced",
            totalPrice: { ...offer.totalPrice, amountMinor: scaled.toString() },
          });
        });
        return { ...outcome, offers: scaledOffers };
      },
    };

    const result = await revalidateSearch(prior, {
      asOf: expiredAsOf,
      port: pricedHigherPort,
      policy,
    });

    expect(result.refetched).toBe(true);

    // Check that the diff has NO became_unavailable or became_available:
    // matched trips must appear as price_changed/unchanged, not as turnover.
    const unavailableCount = result.diff.changes.filter(
      (c) => c.categories.includes("became_unavailable")
    ).length;
    const newAvailableCount = result.diff.changes.filter(
      (c) => c.categories.includes("became_available")
    ).length;
    const priceChangedCount = result.diff.changes.filter(
      (c) => c.categories.includes("price_changed")
    ).length;

    // With content-based keys, same schedule = same key = matched → price_changed
    // With volatile id-based keys (old bug), every trip would become_unavailable + become_available
    expect(priceChangedCount).toBeGreaterThan(0);
    expect(unavailableCount).toBe(0);
    expect(newAvailableCount).toBe(0);
  });
});
