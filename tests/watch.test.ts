/**
 * Item 15 — watched-search auto-update tests (@flightbrain/watch).
 *
 * evaluateWatch is a thin interpretation layer over C009 revalidateSearch: it adds NO
 * facts beyond the diff and only triggers per the user's explicit criteria. All tests use
 * injected asOf (never Date.now), offline discovery + E4 mock port. Synthetic data only.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleSearch } from "@flightbrain/search-api";
import {
  deferredRealProviderIntakePort,
  RealProviderNotImplementedError,
} from "@flightbrain/orchestrator";
import { revalidateSearch, type PriorResult, type RevalidationPolicy } from "@flightbrain/revalidation";
import {
  evaluateWatch,
  WatchCriteriaSchema,
  WatchUpdateSchema,
  type WatchCriteria,
} from "@flightbrain/watch";

const FIXED_AS_OF = "2026-01-15T12:00:00Z"; // within the offers' validity window (1h)

const BASE_REQUEST = {
  origins: ["LHR"] as [string, ...string[]],
  destinations: ["JFK"] as [string, ...string[]],
  departureDate: "2026-03-01",
  adults: 1,
  cabins: ["economy" as const] as ["economy"],
  maxStops: null,
  currency: "USD" as const,
};

async function priorResponse(asOf = FIXED_AS_OF) {
  return handleSearch(BASE_REQUEST, { asOf });
}

function makeWatch(lastResult: Awaited<ReturnType<typeof priorResponse>>, criteria: WatchCriteria) {
  return { request: BASE_REQUEST, lastResult, criteria };
}

function deps(refetchMode: "refetch_always" | "only_when_expired" = "refetch_always", asOf = FIXED_AS_OF) {
  const policy: RevalidationPolicy = { asOf, refetchMode };
  return { asOf, policy };
}

// A port that throws if ever called — proves the refetch path was not taken.
const throwingPort = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async intake(): Promise<any> {
    throw new Error("port.intake must not be called");
  },
};

describe("item15 watch — schema + structure", () => {
  it("WatchCriteria requires at least one criterion (empty rejected)", () => {
    expect(WatchCriteriaSchema.safeParse({}).success).toBe(false);
    expect(WatchCriteriaSchema.safeParse({ notifyOnAnyBetter: true }).success).toBe(true);
  });

  it("evaluateWatch output parses WatchUpdateSchema and is deterministic", async () => {
    const watch = makeWatch(await priorResponse(), { notifyOnAnyBetter: true });
    const a = await evaluateWatch(watch, deps());
    const b = await evaluateWatch(watch, deps());
    expect(() => WatchUpdateSchema.parse(a)).not.toThrow();
    expect(a).toEqual(b);
  });

  it("source watch.ts has no wall-clock/random/fetch and no providers import", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../packages/watch/src/watch.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toMatch(/Date\.now\(/);
    expect(src).not.toMatch(/Math\.random\(/);
    expect(src).not.toMatch(/new Date\(\s*\)/);
    expect(src).not.toMatch(/\bfetch\(/);
    // Import-statement checks (not prose mentions in the doc comment).
    expect(src).not.toMatch(/from\s+["']@flightbrain\/providers["']/);
    expect(src).not.toMatch(/from\s+["']node:crypto["']/);
    expect(src).not.toMatch(/require\(\s*["']node:crypto["']\s*\)/);
  });
});

describe("item15 watch — reuses C009, invents nothing", () => {
  it("passes revalidateSearch's diff through verbatim (does not re-diff)", async () => {
    const response = await priorResponse();
    const watch = makeWatch(response, { notifyOnAnyBetter: true });
    const d = deps();
    const update = await evaluateWatch(watch, d);
    const prior: PriorResult = { priorResponse: response, request: BASE_REQUEST };
    const reval = await revalidateSearch(prior, d);
    expect(update.diff).toEqual(reval.diff);
    expect(update.refetched).toBe(reval.refetched);
  });

  it("every hit maps verbatim to a diff.changes entry (no fabricated change)", async () => {
    const watch = makeWatch(await priorResponse(), {
      notifyOnAnyBetter: true,
      notifyOnExpiry: true,
      notifyOnNewOption: true,
    });
    const update = await evaluateWatch(watch, deps());
    for (const hit of update.hits) {
      const change = update.diff.changes.find((c) => c.stableKey === hit.stableKey);
      expect(change, `hit.stableKey ${hit.stableKey} must exist in diff.changes`).toBeDefined();
      expect(change!.categories).toContain(hit.category);
      expect(hit.derivedFrom).toEqual(change!.derivedFrom);
    }
  });

  it("triggered === (hits non-empty)", async () => {
    const watch = makeWatch(await priorResponse(), { notifyOnAnyBetter: true });
    const update = await evaluateWatch(watch, deps());
    expect(update.triggered).toBe(update.hits.length > 0);
  });
});

describe("item15 watch — triggers only when diff + criteria agree", () => {
  it("identical deterministic re-run with notifyOnAnyBetter → no any_better hit (nothing improved)", async () => {
    const watch = makeWatch(await priorResponse(), { notifyOnAnyBetter: true });
    const update = await evaluateWatch(watch, deps());
    expect(update.hits.some((h) => h.trigger === "any_better")).toBe(false);
  });

  it("notifyOnExpiry off → no expiry hit even if categories present", async () => {
    const watch = makeWatch(await priorResponse(), { notifyOnNewOption: true });
    const update = await evaluateWatch(watch, deps());
    expect(update.hits.some((h) => h.trigger === "offer_expired_or_unavailable")).toBe(false);
  });
});

describe("item15 watch — price_under_ceiling honesty (explicit, no default)", () => {
  it("fires when the new best comparable cash in cashCurrency is <= ceiling", async () => {
    const watch = makeWatch(await priorResponse(), {
      maxCashPriceMinor: "999999999999",
      cashCurrency: "USD",
    });
    const update = await evaluateWatch(watch, deps());
    expect(update.newBest?.metrics?.priceComparableKey.startsWith("USD:")).toBe(true);
    expect(update.hits.some((h) => h.trigger === "price_under_ceiling")).toBe(true);
    expect(update.triggered).toBe(true);
  });

  it("does NOT fire when the ceiling is below the best price", async () => {
    const watch = makeWatch(await priorResponse(), {
      maxCashPriceMinor: "1",
      cashCurrency: "USD",
    });
    const update = await evaluateWatch(watch, deps());
    expect(update.hits.some((h) => h.trigger === "price_under_ceiling")).toBe(false);
  });

  it("does NOT fire for a different (non-matching) currency — no invented FX", async () => {
    const watch = makeWatch(await priorResponse(), {
      maxCashPriceMinor: "999999999999",
      cashCurrency: "EUR",
    });
    const update = await evaluateWatch(watch, deps());
    expect(update.hits.some((h) => h.trigger === "price_under_ceiling")).toBe(false);
  });
});

describe("item15 watch — award honesty", () => {
  it("notifyOnAwardBecameAvailable does NOT fire on cash-only trips (no pointsByProgram)", async () => {
    const response = await priorResponse();
    // Default mock offers are cash-only.
    for (const rt of response.trips) {
      expect(rt.trip.payment.pointsByProgram.length).toBe(0);
    }
    const watch = makeWatch(response, { notifyOnAwardBecameAvailable: true });
    const update = await evaluateWatch(watch, deps());
    expect(update.hits.some((h) => h.trigger === "award_became_available")).toBe(false);
  });
});

describe("item15 watch — projections, empty, no-refetch, gated real provider", () => {
  it("priorBest/newBest project the rank-0 trip with a stableKey + metrics", async () => {
    const response = await priorResponse();
    const watch = makeWatch(response, { notifyOnAnyBetter: true });
    const update = await evaluateWatch(watch, deps());
    if (response.trips.length > 0) {
      expect(update.newBest).not.toBeNull();
      expect(update.newBest!.stableKey.length).toBeGreaterThan(0);
      expect(update.newBest!.metrics).not.toBeNull();
    }
  });

  it("empty prior (no trips) → no trigger, no throw", async () => {
    const response = await priorResponse();
    const emptyResult = { ...response, trips: [] as typeof response.trips, status: "complete" as const };
    const watch = makeWatch(emptyResult, { notifyOnAnyBetter: true, notifyOnExpiry: true });
    const update = await evaluateWatch(watch, deps());
    expect(update.triggered).toBe(false);
    expect(update.hits).toEqual([]);
    expect(update.priorBest).toBeNull();
  });

  it("only_when_expired + fresh prior → port never called, refetched false", async () => {
    // Offers created at FIXED_AS_OF expire ~1h later; evaluating at the same asOf,
    // nothing is expired, so only_when_expired must NOT refetch → the throwing port is safe.
    const response = await priorResponse(FIXED_AS_OF);
    const watch = makeWatch(response, { notifyOnAnyBetter: true });
    const update = await evaluateWatch(watch, {
      asOf: FIXED_AS_OF,
      policy: { asOf: FIXED_AS_OF, refetchMode: "only_when_expired" },
      port: throwingPort,
    });
    expect(update.refetched).toBe(false);
  });

  it("deferredRealProviderIntakePort on a refetch-forcing watch surfaces RealProviderNotImplementedError", async () => {
    const response = await priorResponse(FIXED_AS_OF);
    const watch = makeWatch(response, { notifyOnAnyBetter: true });
    await expect(
      evaluateWatch(watch, {
        asOf: FIXED_AS_OF,
        policy: { asOf: FIXED_AS_OF, refetchMode: "refetch_always" },
        port: deferredRealProviderIntakePort,
      }),
    ).rejects.toBeInstanceOf(RealProviderNotImplementedError);
  });
});
