/**
 * Deterministic SearchResponse fixture builder.
 * Calls handleSearch with the default offline deps + a fixed asOf.
 * No randomness — identical inputs always yield identical output.
 */

import { handleSearch, type SearchResponse } from "@flightbrain/search-api";

export const FIXTURE_AS_OF = "2026-11-01T12:00:00.000Z";

/** A well-known request that reliably produces ranked trips via the offline mock port. */
const FIXTURE_REQUEST = {
  origins: ["SFO"],
  destinations: ["JFK"],
  departureDate: "2026-11-15",
  adults: 1,
  cabins: ["economy" as const],
  maxStops: null,
  currency: "USD" as const,
};

let _cached: SearchResponse | null = null;

/**
 * Returns a deterministic SearchResponse fixture.
 * Lazily computed and cached — safe to call repeatedly in tests.
 */
export async function buildFixture(): Promise<SearchResponse> {
  if (_cached) return _cached;
  _cached = await handleSearch(FIXTURE_REQUEST, { asOf: FIXTURE_AS_OF });
  return _cached;
}

/**
 * Returns a fixture with status "partial" by injecting a diagnostic
 * that triggers partial status coverage.
 * Uses a fresh call each time (not cached).
 */
export async function buildPartialFixture(): Promise<SearchResponse> {
  // We build a base fixture, then manually construct a partial version
  // since the offline pipeline always returns "complete" on success.
  const base = await buildFixture();
  // Build a SearchResponse that is explicitly partial.
  // We do this by injecting the intake_declined diagnostic at orchestration level.
  const { SearchResponseSchema } = await import("@flightbrain/search-api");
  return SearchResponseSchema.parse({
    ...base,
    status: "partial",
    diagnostics: {
      ...base.diagnostics,
      orchestrationDiagnostics: ["intake_declined"],
    },
  });
}

/**
 * Returns a fixture with status "failed".
 */
export async function buildFailedFixture(): Promise<SearchResponse> {
  const base = await buildFixture();
  const { SearchResponseSchema } = await import("@flightbrain/search-api");
  return SearchResponseSchema.parse({
    ...base,
    status: "failed",
    diagnostics: {
      ...base.diagnostics,
      orchestrationDiagnostics: ["plan_request_mismatch"],
    },
  });
}

/**
 * Returns a fixture with mixedCurrencyIncomparable = true (no trips to avoid
 * currency-comparison issues — just the diagnostics flag set).
 */
export async function buildMixedCurrencyFixture(): Promise<SearchResponse> {
  const base = await buildFixture();
  const { SearchResponseSchema } = await import("@flightbrain/search-api");
  return SearchResponseSchema.parse({
    ...base,
    diagnostics: {
      ...base.diagnostics,
      mixedCurrencyIncomparable: true,
    },
  });
}

/**
 * Returns a fixture with zero trips (empty results, complete status).
 */
export async function buildEmptyFixture(): Promise<SearchResponse> {
  const base = await buildFixture();
  const { SearchResponseSchema } = await import("@flightbrain/search-api");
  return SearchResponseSchema.parse({
    ...base,
    trips: [],
    status: "complete",
  });
}
