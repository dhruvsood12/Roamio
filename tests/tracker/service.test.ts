import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CACHE,
  cacheTtl,
  createTrackerService,
} from "../../apps/tracker-server/service";
import {
  TrackerError,
  type StatusProvider,
} from "../../apps/tracker-server/provider";
import { NOW, QUERY, demoResult } from "./helpers";

afterEach(() => vi.useRealTimers());
async function setup() {
  const result = await demoResult();
  let monotonic = 0,
    wall = NOW;
  const search = vi.fn(async () => structuredClone(result));
  const provider: StatusProvider = {
    health: {
      mode: "demo",
      provider: "roamio_demo",
      configured: true,
      examples: [],
    },
    search,
  };
  const service = createTrackerService(provider, {
    clock: () => wall,
    monotonic: () => monotonic,
  });
  return {
    result,
    search,
    provider,
    service,
    advance(ms: number) {
      monotonic += ms;
      wall += ms;
    },
    rollback(ms: number) {
      wall -= ms;
    },
  };
}
describe("bounded tracker cache and provider service", () => {
  it("cancels pending work and clears deadlines immediately on shutdown", async () => {
    vi.useFakeTimers();
    const s = await setup();
    s.provider.search = vi.fn(() => new Promise<never>(() => {}));
    const service = createTrackerService(s.provider);
    const pending = service.search(QUERY);
    const assertion = expect(pending).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
    service.close();
    await assertion;
    expect(service.stats().pending).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("normalizes before cache keying and doesn't mutate cached observations", async () => {
    const s = await setup();
    const first = await s.service.search({
      ...QUERY,
      flightNumber: " rm 104 ",
    });
    first.flights[0].origin.gate = "mutated";
    expect((await s.service.search(QUERY)).flights[0].origin.gate).toBe("F12");
    expect(s.search).toHaveBeenCalledTimes(1);
  });
  it("expires on monotonic time, not local wall clock", async () => {
    const s = await setup();
    await s.service.search(QUERY);
    s.rollback(86_400_000);
    s.advance(CACHE.demoMs - 1);
    await s.service.search(QUERY);
    expect(s.search).toHaveBeenCalledTimes(1);
    s.advance(1);
    await s.service.search(QUERY);
    expect(s.search).toHaveBeenCalledTimes(2);
  });
  it("coalesces simultaneous requests and returns independent objects", async () => {
    const s = await setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => s.service.search(QUERY)),
    );
    expect(s.search).toHaveBeenCalledTimes(1);
    results[0].flights[0].data.stale = true;
    expect(results[1].flights[0].data.stale).toBe(false);
    expect(s.service.stats().pending).toBe(0);
  });
  it("preserves original receipt and marks failed refresh fallback stale", async () => {
    const s = await setup();
    await s.service.search(QUERY);
    s.advance(CACHE.demoMs);
    s.search.mockRejectedValue(new TrackerError("provider_unavailable"));
    const fallback = await s.service.search(QUERY);
    expect(fallback.flights[0].data.stale).toBe(true);
    expect(fallback.flights[0].data.retrievedAt).toBe(
      s.result.flights[0].data.retrievedAt,
    );
    expect(fallback.flights[0].data.notices).toContain("refresh_failed");
    expect(fallback.servedAt).not.toBe(s.result.servedAt);
    await s.service.search(QUERY);
    expect(s.search).toHaveBeenCalledTimes(2);
  });
  it("does not serve stale observations beyond the fallback limit", async () => {
    const s = await setup();
    await s.service.search(QUERY);
    s.advance(CACHE.staleMs + 1);
    s.search.mockRejectedValue(new TrackerError("provider_unavailable"));
    await expect(s.service.search(QUERY)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });
  it("does not resurrect cache after definitive not-found", async () => {
    const s = await setup();
    await s.service.search(QUERY);
    s.advance(CACHE.demoMs);
    s.search.mockRejectedValue(new TrackerError("flight_not_found"));
    await expect(s.service.search(QUERY)).rejects.toMatchObject({
      code: "flight_not_found",
    });
    expect(s.service.stats().cached).toBe(0);
    s.advance(CACHE.errorMs);
    s.search.mockRejectedValue(new TrackerError("provider_unavailable"));
    await expect(s.service.search(QUERY)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });
  it("honors provider rate-limit cooldown globally across identifiers", async () => {
    const s = await setup();
    s.search.mockRejectedValue(new TrackerError("rate_limited", 60));
    await expect(s.service.search(QUERY)).rejects.toMatchObject({
      code: "rate_limited",
    });
    await expect(
      s.service.search({ ...QUERY, flightNumber: "RM101" }),
    ).rejects.toMatchObject({ retryAfterSeconds: 60 });
    expect(s.search).toHaveBeenCalledTimes(1);
    s.advance(60_000);
    await expect(s.service.search(QUERY)).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(s.search).toHaveBeenCalledTimes(2);
  });
  it("cleans up synchronous provider throws and failed coalesced calls", async () => {
    const s = await setup();
    s.search.mockImplementation(() => {
      throw new Error("secret");
    });
    const calls = await Promise.allSettled([
      s.service.search(QUERY),
      s.service.search(QUERY),
    ]);
    expect(calls.every((c) => c.status === "rejected")).toBe(true);
    expect(s.service.stats().pending).toBe(0);
    s.advance(CACHE.errorMs);
    s.search.mockResolvedValue(s.result);
    expect(await s.service.search(QUERY)).toMatchObject({ query: QUERY });
  });
  it("times out an uncooperative provider and cleans up its signal/promise", async () => {
    vi.useFakeTimers();
    const s = await setup();
    let signal: AbortSignal | undefined;
    s.provider.search = vi.fn((_q, sig) => {
      signal = sig;
      return new Promise<never>(() => {});
    });
    const service = createTrackerService(s.provider, { timeoutMs: 100 });
    const promise = service.search(QUERY);
    const assertion = expect(promise).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(service.stats().pending).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds concurrent provider work", async () => {
    vi.useFakeTimers();
    const s = await setup();
    s.provider.search = vi.fn(() => new Promise<never>(() => {}));
    const service = createTrackerService(s.provider, { timeoutMs: 100 });
    const calls = Array.from({ length: 4 }, (_, n) =>
      service.search({ ...QUERY, flightNumber: `RM10${n}` }).catch((e) => e),
    );
    await expect(
      service.search({ ...QUERY, flightNumber: "RM199" }),
    ).rejects.toMatchObject({ code: "temporarily_unavailable" });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(calls);
    expect(s.provider.search).toHaveBeenCalledTimes(4);
    expect(service.stats().pending).toBe(0);
  });
  it("bounds cache and error retention", async () => {
    const s = await setup();
    s.provider.search = vi.fn(async (q) => {
      const r = structuredClone(s.result);
      r.query = q;
      r.flights[0].flight.requestedIdent = q.flightNumber;
      return r;
    });
    const service = createTrackerService(s.provider);
    for (let n = 0; n < 150; n++)
      await service.search({ ...QUERY, flightNumber: `RM${n}` });
    expect(service.stats().cached).toBe(CACHE.maxEntries);
  });
  it("rejects responses bound to a different query", async () => {
    const s = await setup();
    await expect(
      s.service.search({ ...QUERY, flightNumber: "RM101" }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it("rejects a provider mode mismatch", async () => {
    const s = await setup();
    s.result.flights[0].data.mode = "live";
    await expect(s.service.search(QUERY)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });
  it("rejects malformed requests before calling provider", async () => {
    const s = await setup();
    await expect(
      s.service.search({ ...QUERY, date: "not-date" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(s.search).not.toHaveBeenCalled();
  });
  it("rejects new work after close", async () => {
    const s = await setup();
    s.service.close();
    await expect(s.service.search(QUERY)).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
  });
  it("uses documented status-specific TTLs", async () => {
    const r = await demoResult();
    expect(cacheTtl(r)).toBe(CACHE.demoMs);
    r.flights[0].data.mode = "live";
    expect(cacheTtl(r)).toBe(CACHE.activeMs);
    r.flights[0].status = "scheduled";
    expect(cacheTtl(r)).toBe(CACHE.scheduledMs);
    r.flights[0].status = "arrived";
    expect(cacheTtl(r)).toBe(CACHE.completedMs);
  });
});
