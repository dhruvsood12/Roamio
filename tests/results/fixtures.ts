/**
 * Test fixtures — re-export from app fixtures + helpers for constructing edge-case responses.
 */

export {
  FIXTURE_AS_OF,
  buildFixture,
  buildPartialFixture,
  buildFailedFixture,
  buildMixedCurrencyFixture,
  buildEmptyFixture,
} from "../../apps/results-web/src/fixtures";

// ---------------------------------------------------------------------------
// Edge-case fixture builders: self_transfer, unknown-protection, expired
// ---------------------------------------------------------------------------

import {
  createTripOption,
  FlightOfferSchema,
  type FlightOffer,
  type Segment,
  type TripPlan,
} from "@flightbrain/domain";
import {
  rankTripOptions,
  tripRankMetrics,
  tripReasons,
  RankedTripOptionSchema,
} from "@flightbrain/ranking";
import {
  SearchResponseSchema,
  RankedTripResultSchema,
  TripFreshnessSchema,
  type SearchResponse,
} from "@flightbrain/search-api";
import { itineraryFingerprint } from "@flightbrain/orchestrator";
import { offerWithJourneys } from "../fixtures/journeys";
import { FIXTURE_AS_OF } from "../../apps/results-web/src/fixtures";

// Fixed segments for deterministic fixture construction.
// Different route from tests/fixtures/trips.ts to avoid id collisions with ranking tests.
function fixtureSegments(): [Segment, Segment, Segment] {
  const common = { marketingCarrier: "FB", operatingCarrier: "FB", cabin: "economy" as const };
  return [
    { ...common, origin: "SFO", destination: "ORD", departureAt: "2026-11-15T08:00:00Z", arrivalAt: "2026-11-15T13:00:00Z", marketingFlightNumber: "201", operatingFlightNumber: "201" },
    { ...common, origin: "ORD", destination: "BOS", departureAt: "2026-11-15T15:00:00Z", arrivalAt: "2026-11-15T18:00:00Z", marketingFlightNumber: "202", operatingFlightNumber: "202" },
    { ...common, origin: "BOS", destination: "JFK", departureAt: "2026-11-15T20:00:00Z", arrivalAt: "2026-11-15T21:30:00Z", marketingFlightNumber: "203", operatingFlightNumber: "203" },
  ];
}

function fixtureOffer(segments: [Segment, ...Segment[]], id: string, overrides?: Partial<FlightOffer>): FlightOffer {
  const base = { ...offerWithJourneys([{ segments }]), id, providerOfferId: `fb-source-${id}` };
  return FlightOfferSchema.parse({ ...base, ...overrides });
}

function planFor(offers: [FlightOffer, ...FlightOffer[]]): TripPlan {
  return {
    id: `fixture-trip-${offers.map((o) => o.id).join("-")}`,
    sourceOffers: offers,
    bookingComponents: offers.map((offer, i) => ({
      id: `fb-component-${i}`, provider: offer.provider, providerOfferId: offer.providerOfferId, offerId: offer.id,
      sourceOfferIndex: i, scheduleFingerprint: itineraryFingerprint(offer), order: i,
      payment: { kind: "cash" as const, amount: offer.totalPrice },
    })) as TripPlan["bookingComponents"],
    journeys: [{
      requestedOrigin: offers[0].journeys[0].segments[0].origin,
      requestedDestination: offers[offers.length - 1].journeys[0].segments.at(-1)!.destination,
      segments: offers.flatMap((offer, componentIndex) =>
        offer.journeys[0].segments.map((_, segmentIndex) => ({ componentIndex, journeyIndex: 0, segmentIndex }))
      ) as TripPlan["journeys"][0]["segments"],
    }],
    protectionFacts: [],
  };
}

/** Split-ticket plan: 3 separate offers → self_transfer connections. */
function splitFixturePlan(): TripPlan {
  const segs = fixtureSegments();
  const offers = segs.map((s, i) => fixtureOffer([s], `fb-offer-split-${i}`)) as [FlightOffer, ...FlightOffer[]];
  return planFor(offers);
}

/** Single-offer plan: one offer with 3 segments → unknown-protection connections. */
function singleFixturePlan(offerOverrides?: Partial<FlightOffer>): TripPlan {
  const segs = fixtureSegments();
  const offer = fixtureOffer(segs, "fb-offer-single", offerOverrides);
  return planFor([offer]);
}

/** Build a valid TripFreshness for a TripOption. */
function buildFreshness(trip: ReturnType<typeof createTripOption>, asOf: string) {
  const asOfMs = Date.parse(asOf);
  let minRetrievedAt = trip.sourceOffers[0].retrievedAt;
  let maxRetrievedAt = trip.sourceOffers[0].retrievedAt;
  let nearestExpiresAt: string | null = null;
  let requiresRevalidation = false;

  for (const src of trip.sourceOffers) {
    if (src.retrievedAt < minRetrievedAt) minRetrievedAt = src.retrievedAt;
    if (src.retrievedAt > maxRetrievedAt) maxRetrievedAt = src.retrievedAt;
    if (src.requiresRevalidation) requiresRevalidation = true;
    if (src.expiresAt != null) {
      const ms = Date.parse(src.expiresAt);
      if (ms <= asOfMs) requiresRevalidation = true;
      if (nearestExpiresAt === null || src.expiresAt < nearestExpiresAt) nearestExpiresAt = src.expiresAt;
    }
  }

  return TripFreshnessSchema.parse({ minRetrievedAt, maxRetrievedAt, nearestExpiresAt, requiresRevalidation });
}

/** Wrap a single TripOption into a minimal valid SearchResponse. */
function wrapAsSearchResponse(
  tripOption: ReturnType<typeof createTripOption>,
  asOf: string,
  searchId: string,
): SearchResponse {
  const policy = { asOf, preferredCurrency: "USD" as const };
  const rankResult = rankTripOptions([tripOption], policy);
  const ranked = rankResult.ranked[0];
  const freshness = buildFreshness(tripOption, asOf);
  const hasSelfTransfer = tripOption.connections.some((c) => c.protection === "self_transfer");
  const hasUnknownProtection = tripOption.connections.some((c) => c.protection === "unknown");

  const rankedTripResult = RankedTripResultSchema.parse({
    trip: ranked.trip,
    metrics: ranked.metrics,
    reasons: ranked.reasons,
    freshness,
    hasSelfTransfer,
    hasUnknownProtection,
    fullyFeasible: true,
  });

  const tripCount = 1;
  return SearchResponseSchema.parse({
    searchId,
    status: "complete",
    asOf,
    coverage: {
      candidatesDiscovered: 1,
      jobsPlanned: 1,
      jobsAdmitted: 1,
      intakeOffered: 1,
      intakeDeclined: 0,
      tripsComposed: tripCount,
      tripsRanked: tripCount,
    },
    trips: [rankedTripResult],
    diagnostics: {
      planningDiagnostics: [],
      admissibilityDiagnostics: [],
      resolutionDiagnostics: [],
      compositionDiagnostics: [],
      orchestrationDiagnostics: [],
      rankingDiagnostics: [],
      mixedCurrencyIncomparable: false,
      pointsIncomparableAcrossPrograms: false,
    },
  });
}

/**
 * Returns a SearchResponse containing exactly one trip with self_transfer connections.
 * Built via splitFixturePlan() — 3 separate booking components, so component boundary
 * crossings yield protection = "self_transfer". hasSelfTransfer = true.
 */
export function buildSelfTransferFixture(): SearchResponse {
  const trip = createTripOption(splitFixturePlan());
  return wrapAsSearchResponse(trip, FIXTURE_AS_OF, "fixture-self-transfer");
}

/**
 * Returns a SearchResponse containing exactly one trip with unknown-protection connections.
 * Built via singleFixturePlan() with no protectionFacts — single-component, multi-segment
 * connections default to protection = "unknown". hasUnknownProtection = true.
 */
export function buildUnknownProtectionFixture(): SearchResponse {
  const trip = createTripOption(singleFixturePlan());
  return wrapAsSearchResponse(trip, FIXTURE_AS_OF, "fixture-unknown-protection");
}

/**
 * Returns a SearchResponse containing exactly one trip whose offer has EXPIRED
 * (expiresAt = "2026-11-01T11:00:00Z" <= FIXTURE_AS_OF "2026-11-01T12:00:00.000Z").
 * The freshness badge for this trip must be "expired".
 * Note: retrievedAt must precede expiresAt (FlightOffer constraint).
 */
export function buildExpiredFixture(): SearchResponse {
  const trip = createTripOption(singleFixturePlan({
    id: "fb-offer-expired",
    providerOfferId: "fb-source-fb-offer-expired",
    retrievedAt: "2026-11-01T10:00:00Z",
    expiresAt: "2026-11-01T11:00:00Z",   // <= FIXTURE_AS_OF → expired
    requiresRevalidation: false,
  }));
  return wrapAsSearchResponse(trip, FIXTURE_AS_OF, "fixture-expired");
}
