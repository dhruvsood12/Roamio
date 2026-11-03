import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FlightOfferSchema,
  ProviderSearchResultSchema,
  SearchRequestSchema,
  type SearchRequest,
} from "@flightbrain/domain";
import { groupOffersByItinerary, searchAll } from "@flightbrain/orchestrator";
import {
  MOCK_PROVIDER_CORPUS,
  ProviderErrorScenarioError,
  createMockFlightProvider,
  runProvider,
  type MockProviderPolicy,
  type MockProviderScenario,
} from "@flightbrain/providers";

const BASE_POLICY: MockProviderPolicy = {
  asOf: "2026-10-01T10:00:00.000Z",
  seed: 42,
  scenarios: ["nonstop"],
  currency: "USD",
  offerValidityMs: 3_600_000, // 1 hour
};

const BASE_REQUEST: SearchRequest = SearchRequestSchema.parse({
  origins: ["JFK"],
  destinations: ["LHR"],
  departureDate: "2026-11-15",
  cabins: ["economy"],
  currency: "USD",
});

function makeMock(scenarios: MockProviderScenario[], currency = "USD" as const, seed = 42) {
  return createMockFlightProvider({
    id: "mock:test",
    capabilities: { cashSearch: true, awardSearch: false, revalidation: false, booking: false, flexibleDates: false },
    policy: { ...BASE_POLICY, scenarios, currency, seed },
  });
}

// ── 1: satisfies FlightProvider + runProvider → ProviderSearchResultSchema ──

describe("C005 — mock provider basics", () => {
  it("createMockFlightProvider satisfies FlightProvider interface", () => {
    const mock = makeMock(["nonstop"]);
    expect(typeof mock.id).toBe("string");
    expect(mock.id).toMatch(/^mock:/);
    expect(typeof mock.search).toBe("function");
    expect(mock.capabilities).toBeDefined();
  });

  it("runProvider result passes ProviderSearchResultSchema for nonstop", async () => {
    const mock = makeMock(["nonstop"]);
    const result = await runProvider(mock, BASE_REQUEST);
    expect(() => ProviderSearchResultSchema.parse(result)).not.toThrow();
    expect(result.status).toBe("success");
    expect(result.offers.length).toBeGreaterThan(0);
  });

  it("id must match /^mock:/ — invalid id throws", () => {
    expect(() => createMockFlightProvider({
      id: "real-provider",
      capabilities: { cashSearch: true, awardSearch: false, revalidation: false, booking: false, flexibleDates: false },
      policy: BASE_POLICY,
    })).toThrow(/mock:/);
  });
});

// ── 2: deterministic ──

describe("C005 — determinism", () => {
  it("two search() calls with identical (request, policy, seed, asOf) deep-equal", async () => {
    const mock1 = makeMock(["nonstop", "one_stop"]);
    const mock2 = makeMock(["nonstop", "one_stop"]);
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const a = await mock1.search(BASE_REQUEST, ctrl1.signal);
    const b = await mock2.search(BASE_REQUEST, ctrl2.signal);
    expect(a).toEqual(b);
  });

  it("different seeds produce different offers", async () => {
    const mock1 = makeMock(["nonstop"], "USD", 1);
    const mock2 = makeMock(["nonstop"], "USD", 999);
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const a = await mock1.search(BASE_REQUEST, ctrl1.signal);
    const b = await mock2.search(BASE_REQUEST, ctrl2.signal);
    expect(a).not.toEqual(b);
  });
});

// ── 3: OFFLINE static scan ──

describe("C005 — offline static scan", () => {
  const root = resolve(__dirname, "..");
  const mockProviderSrc = readFileSync(`${root}/packages/providers/src/mock-provider.ts`, "utf-8");
  const syntheticSrc = readFileSync(`${root}/packages/providers/src/synthetic.ts`, "utf-8");
  const corpusSrc = readFileSync(`${root}/packages/providers/src/fixtures/corpus.ts`, "utf-8");

  it("mock-provider.ts contains no Date.now()", () => {
    expect(mockProviderSrc).not.toMatch(/Date\.now\s*\(/);
  });
  it("mock-provider.ts contains no new Date() without argument", () => {
    // Allow new Date(something) but not new Date()
    expect(mockProviderSrc).not.toMatch(/new\s+Date\s*\(\s*\)/);
  });
  it("mock-provider.ts contains no Math.random()", () => {
    expect(mockProviderSrc).not.toMatch(/Math\.random\s*\(/);
  });
  it("mock-provider.ts contains no fetch(", () => {
    expect(mockProviderSrc).not.toMatch(/\bfetch\s*\(/);
  });

  it("synthetic.ts contains no Date.now()", () => {
    expect(syntheticSrc).not.toMatch(/Date\.now\s*\(/);
  });
  it("synthetic.ts contains no new Date() without argument", () => {
    expect(syntheticSrc).not.toMatch(/new\s+Date\s*\(\s*\)/);
  });
  it("synthetic.ts contains no Math.random()", () => {
    expect(syntheticSrc).not.toMatch(/Math\.random\s*\(/);
  });
  it("synthetic.ts contains no fetch(", () => {
    expect(syntheticSrc).not.toMatch(/\bfetch\s*\(/);
  });

  it("corpus.ts contains no Date.now()", () => {
    expect(corpusSrc).not.toMatch(/Date\.now\s*\(/);
  });
  it("corpus.ts contains no new Date() without argument", () => {
    // corpus.ts mints every offer timestamp — guard the exact wall-clock footgun
    // (allows new Date(ms) but not the no-arg wall-clock form).
    expect(corpusSrc).not.toMatch(/new\s+Date\s*\(\s*\)/);
  });
  it("corpus.ts contains no Math.random()", () => {
    expect(corpusSrc).not.toMatch(/Math\.random\s*\(/);
  });
  it("corpus.ts contains no fetch(", () => {
    expect(corpusSrc).not.toMatch(/\bfetch\s*\(/);
  });
});

// ── 4: every offer: provider /^mock:/, requiresRevalidation, synthetic providerMetadata ──

describe("C005 — offer provenance", () => {
  const scenarios: MockProviderScenario[] = ["nonstop", "one_stop", "codeshare", "airport_change", "self_transfer", "mixed_cabin", "stale", "duplicate"];

  it.each(scenarios)("scenario '%s': all offers have correct provenance", async (scenario) => {
    const mock = makeMock([scenario]);
    const ctrl = new AbortController();
    const offers = await mock.search(BASE_REQUEST, ctrl.signal);
    if (offers.length === 0 && scenario !== "no_results") return; // scenario may filter all due to route
    for (const offer of offers) {
      expect(offer.provider).toMatch(/^mock:/);
      expect(offer.requiresRevalidation).toBe(true);
      expect(offer.providerMetadata["synthetic"]).toBe(true);
      expect(typeof offer.providerMetadata["disclaimer"]).toBe("string");
      expect((offer.providerMetadata["disclaimer"] as string).length).toBeGreaterThan(0);
    }
  });
});

// ── 5: every corpus scenario → offers pass FlightOfferSchema.parse ──

describe("C005 — schema validity per scenario", () => {
  const cfg = {
    providerId: "mock:corpus-test",
    asOf: "2026-10-01T10:00:00.000Z",
    seed: 7,
    currency: "USD" as const,
    offerValidityMs: 3_600_000,
    origin: "JFK",
    destination: "LHR",
    departureDate: "2026-11-15",
  };

  const honestScenarios: MockProviderScenario[] = ["nonstop", "one_stop", "codeshare", "airport_change", "self_transfer", "mixed_cabin", "stale", "duplicate", "no_results"];

  it.each(honestScenarios)("corpus scenario '%s' builds schema-valid offers", (scenario) => {
    const builder = MOCK_PROVIDER_CORPUS[scenario];
    expect(() => {
      const offers = builder(cfg);
      for (const offer of offers) {
        FlightOfferSchema.parse(offer);
      }
    }).not.toThrow();
  });

  it("corpus scenario 'provider_error' throws", () => {
    expect(() => MOCK_PROVIDER_CORPUS["provider_error"](cfg)).toThrow();
  });
});

// ── 6: warning scenarios carry right warnings ──

describe("C005 — warning scenarios", () => {
  const cfg = {
    providerId: "mock:warn-test",
    asOf: "2026-10-01T10:00:00.000Z",
    seed: 13,
    currency: "USD" as const,
    offerValidityMs: 3_600_000,
    origin: "JFK",
    destination: "LAX",
    departureDate: "2026-11-15",
  };

  it("mixed_cabin offers carry mixed_cabin warning", () => {
    const offers = MOCK_PROVIDER_CORPUS["mixed_cabin"](cfg);
    for (const offer of offers) {
      expect(offer.warnings).toContain("mixed_cabin");
    }
  });

  it("airport_change offers carry airport_change warning and have non-contiguous segment airports", () => {
    const offers = MOCK_PROVIDER_CORPUS["airport_change"](cfg);
    for (const offer of offers) {
      expect(offer.warnings).toContain("airport_change");
      // Verify there is actually an airport change in the journey
      for (const journey of offer.journeys) {
        const hasAirportChange = journey.segments.some(
          (seg, i) => i > 0 && seg.origin !== journey.segments[i - 1].destination,
        );
        expect(hasAirportChange).toBe(true);
      }
    }
  });

  it("self_transfer offers carry self_transfer warning and have multiple independent journeys", () => {
    const offers = MOCK_PROVIDER_CORPUS["self_transfer"](cfg);
    for (const offer of offers) {
      expect(offer.warnings).toContain("self_transfer");
      expect(offer.journeys.length).toBeGreaterThan(1);
    }
  });

  it("stale offers carry stale_price warning and have expiresAt set", () => {
    const offers = MOCK_PROVIDER_CORPUS["stale"](cfg);
    for (const offer of offers) {
      expect(offer.warnings).toContain("stale_price");
      expect(offer.expiresAt).not.toBeNull();
    }
  });
});

// ── 7: codeshare — operatingCarrier/Number distinct from marketing ──

describe("C005 — codeshare", () => {
  it("codeshare offers have operatingCarrier/Number distinct from marketing", () => {
    const cfg = {
      providerId: "mock:codeshare-test",
      asOf: "2026-10-01T10:00:00.000Z",
      seed: 99,
      currency: "USD" as const,
      offerValidityMs: 3_600_000,
      origin: "JFK",
      destination: "LHR",
      departureDate: "2026-11-15",
    };
    const offers = MOCK_PROVIDER_CORPUS["codeshare"](cfg);
    for (const offer of offers) {
      for (const journey of offer.journeys) {
        for (const seg of journey.segments) {
          // operatingCarrier must be set (not null) for codeshare
          expect(seg.operatingCarrier).not.toBeNull();
          expect(seg.operatingFlightNumber).not.toBeNull();
          // and must differ from marketing
          expect(seg.operatingCarrier).not.toBe(seg.marketingCarrier);
        }
      }
    }
  });
});

// ── 8: duplicate → groupOffersByItinerary collapses to one fingerprint group ──

describe("C005 — duplicate scenario", () => {
  it("duplicate offers collapse to one fingerprint group via groupOffersByItinerary", () => {
    const cfg = {
      providerId: "mock:dup-test",
      asOf: "2026-10-01T10:00:00.000Z",
      seed: 7,
      currency: "USD" as const,
      offerValidityMs: 3_600_000,
      origin: "JFK",
      destination: "LHR",
      departureDate: "2026-11-15",
    };
    const offers = MOCK_PROVIDER_CORPUS["duplicate"](cfg);
    expect(offers.length).toBeGreaterThanOrEqual(2);
    const groups = groupOffersByItinerary(offers);
    // All duplicate offers have the same schedule → one group
    const nonNullGroups = groups.filter((g) => g.scheduleFingerprint !== null);
    expect(nonNullGroups.length).toBe(1);
    expect(nonNullGroups[0].offers.length).toBe(offers.length);
  });
});

// ── 9: no_results ──

describe("C005 — no_results scenario", () => {
  it("no_results: search() resolves with empty array", async () => {
    const mock = makeMock(["no_results"]);
    const ctrl = new AbortController();
    const offers = await mock.search(BASE_REQUEST, ctrl.signal);
    expect(offers).toEqual([]);
  });

  it("no_results: runProvider status success, zero offers", async () => {
    const mock = makeMock(["no_results"]);
    const result = await runProvider(mock, BASE_REQUEST);
    expect(result.status).toBe("success");
    expect(result.offers).toEqual([]);
    expect(() => ProviderSearchResultSchema.parse(result)).not.toThrow();
  });
});

// ── 10: provider_error ──

describe("C005 — provider_error scenario", () => {
  it("provider_error: search() throws ProviderErrorScenarioError", async () => {
    const mock = makeMock(["provider_error"]);
    const ctrl = new AbortController();
    await expect(mock.search(BASE_REQUEST, ctrl.signal)).rejects.toThrow(ProviderErrorScenarioError);
  });

  it("provider_error: runProvider status error, zero offers, superRefine holds", async () => {
    const mock = makeMock(["provider_error"]);
    const result = await runProvider(mock, BASE_REQUEST);
    expect(result.status).toBe("error");
    expect(result.offers).toEqual([]);
    expect(result.errorCode).toBe("ProviderErrorScenarioError");
    expect(() => ProviderSearchResultSchema.parse(result)).not.toThrow();
  });
});

// ── 11: timeout ──

describe("C005 — timeout scenario", () => {
  it("timeout: search() rejects on AbortSignal abort", async () => {
    const mock = makeMock(["timeout"]);
    const ctrl = new AbortController();
    // Immediately abort
    ctrl.abort();
    await expect(mock.search(BASE_REQUEST, ctrl.signal)).rejects.toThrow();
  });

  it("timeout: search() started unaborted stays pending, then rejects when aborted (listener path)", async () => {
    // Covers the addEventListener('abort') path, not just the pre-abort early-return guard:
    // an honest timeout must block on the signal and only reject on abort — never resolve
    // with offers after a delay.
    const mock = makeMock(["timeout"]);
    const ctrl = new AbortController();
    const p = mock.search(BASE_REQUEST, ctrl.signal);
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(false); // still pending while unaborted — no fake sleep-then-resolve
    ctrl.abort();
    await expect(p).rejects.toThrow();
  }, 5000);

  it("timeout: runProvider with small timeout → status timeout, zero offers", async () => {
    const mock = makeMock(["timeout"]);
    const result = await runProvider(mock, BASE_REQUEST, 50); // 50ms timeout
    expect(result.status).toBe("timeout");
    expect(result.offers).toEqual([]);
    expect(() => ProviderSearchResultSchema.parse(result)).not.toThrow();
  }, 5000);
});

// ── 12: request fields honored ──

describe("C005 — request fields honored", () => {
  it("endpoints match: offers have origin in request.origins, destination in request.destinations", async () => {
    const mock = makeMock(["nonstop", "one_stop"]);
    const ctrl = new AbortController();
    const offers = await mock.search(BASE_REQUEST, ctrl.signal);
    for (const offer of offers) {
      const firstJourney = offer.journeys[0];
      const firstSeg = firstJourney.segments[0];
      const lastSeg = firstJourney.segments[firstJourney.segments.length - 1];
      expect(BASE_REQUEST.origins).toContain(firstSeg.origin);
      expect(BASE_REQUEST.destinations).toContain(lastSeg.destination);
    }
  });

  it("currency of offers matches request.currency", async () => {
    const request = SearchRequestSchema.parse({
      origins: ["JFK"],
      destinations: ["LHR"],
      departureDate: "2026-11-15",
      cabins: ["economy"],
      currency: "EUR",
    });
    const mock = createMockFlightProvider({
      id: "mock:eur-test",
      capabilities: { cashSearch: true, awardSearch: false, revalidation: false, booking: false, flexibleDates: false },
      policy: { ...BASE_POLICY, currency: "EUR", scenarios: ["nonstop"] },
    });
    const ctrl = new AbortController();
    const offers = await mock.search(request, ctrl.signal);
    for (const offer of offers) {
      expect(offer.totalPrice.currency).toBe("EUR");
      expect(offer.totalPrice.exponent).toBe(2); // EUR exponent
    }
  });

  it("maxStops=0 returns only nonstop offers", async () => {
    const nonstopRequest = SearchRequestSchema.parse({
      origins: ["JFK"],
      destinations: ["LHR"],
      departureDate: "2026-11-15",
      cabins: ["economy"],
      maxStops: 0,
      currency: "USD",
    });
    const mock = makeMock(["nonstop", "one_stop"]);
    const ctrl = new AbortController();
    const offers = await mock.search(nonstopRequest, ctrl.signal);
    for (const offer of offers) {
      const firstJourney = offer.journeys[0];
      expect(firstJourney.segments.length).toBe(1); // nonstop only
    }
  });
});

// ── 13: mixed-currency corpus offers parse ──

describe("C005 — mixed currency corpus", () => {
  const currencies = ["EUR", "GBP", "INR", "JPY", "KWD", "SEK", "USD"] as const;

  it.each(currencies)("currency %s produces schema-valid offers", (currency) => {
    const cfg = {
      providerId: "mock:currency-test",
      asOf: "2026-10-01T10:00:00.000Z",
      seed: 5,
      currency,
      offerValidityMs: 3_600_000,
      origin: "JFK",
      destination: "LHR",
      departureDate: "2026-11-15",
    };
    const offers = MOCK_PROVIDER_CORPUS["nonstop"](cfg);
    for (const offer of offers) {
      expect(() => FlightOfferSchema.parse(offer)).not.toThrow();
      expect(offer.totalPrice.currency).toBe(currency);
    }
  });
});

// ── 14: no input mutation ──

describe("C005 — no input mutation", () => {
  it("structuredClone(request) is unchanged after search()", async () => {
    const mock = makeMock(["nonstop", "mixed_cabin"]);
    const ctrl = new AbortController();
    const before = structuredClone(BASE_REQUEST);
    await mock.search(BASE_REQUEST, ctrl.signal);
    expect(BASE_REQUEST).toEqual(before);
  });
});

// ── 15: e2e searchAll ──

describe("C005 — e2e searchAll", () => {
  it("searchAll(request, [mock]) → schema-valid providerResults, itineraryGroups, paretoOffers", async () => {
    const mock = makeMock(["nonstop", "one_stop", "codeshare"]);
    const result = await searchAll(BASE_REQUEST, [mock]);
    expect(result.status).toBe("partial_or_complete");
    for (const pr of result.providerResults) {
      expect(() => ProviderSearchResultSchema.parse(pr)).not.toThrow();
    }
    expect(Array.isArray(result.itineraryGroups)).toBe(true);
    expect(Array.isArray(result.paretoOffers)).toBe(true);
    // All pareto offers should be schema-valid
    for (const offer of result.paretoOffers) {
      expect(() => FlightOfferSchema.parse(offer)).not.toThrow();
    }
  });
});
