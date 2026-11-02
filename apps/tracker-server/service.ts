import {
  QuerySchema,
  SearchResultSchema,
  isStale,
  queryKey,
  type FlightQuery,
  type SearchResult,
} from "../tracker-shared/contracts";
import {
  TrackerError,
  publicError,
  iso,
  type StatusProvider,
} from "./provider";

export const CACHE = {
  activeMs: 30_000,
  scheduledMs: 120_000,
  completedMs: 300_000,
  demoMs: 10_000,
  staleMs: 15 * 60_000,
  errorMs: 15_000,
  maxEntries: 128,
  maxConcurrent: 4,
  timeoutMs: 12_000,
} as const;
export function cacheTtl(result: SearchResult): number {
  return Math.min(
    ...result.flights.map((f) =>
      f.data.mode === "demo"
        ? CACHE.demoMs
        : ["arrived", "landed", "cancelled"].includes(f.status)
          ? CACHE.completedMs
          : ["in_air", "departed", "boarding", "diverted"].includes(f.status)
            ? CACHE.activeMs
            : CACHE.scheduledMs,
    ),
  );
}
export function createTrackerService(
  provider: StatusProvider,
  options: {
    clock?: () => number;
    monotonic?: () => number;
    timeoutMs?: number;
  } = {},
) {
  const clock = options.clock ?? Date.now,
    mono = options.monotonic ?? (() => performance.now());
  const cache = new Map<
    string,
    { result: SearchResult; written: number; expires: number }
  >();
  const errors = new Map<string, { error: TrackerError; expires: number }>();
  const pending = new Map<string, Promise<SearchResult>>();
  const controllers = new Set<AbortController>();
  let cooldown = 0,
    closed = false;
  const served = (result: SearchResult, stale = false): SearchResult => {
    const copy = structuredClone(result);
    copy.servedAt = iso(clock());
    for (const f of copy.flights) {
      f.data.stale = stale || isStale(f, clock());
      if (
        stale &&
        f.data.notices.length < 5 &&
        !f.data.notices.includes("refresh_failed")
      )
        f.data.notices.push("refresh_failed");
    }
    return copy;
  };
  function boundedSet<T>(map: Map<string, T>, key: string, value: T) {
    map.delete(key);
    if (map.size >= CACHE.maxEntries) map.delete(map.keys().next().value!);
    map.set(key, value);
  }
  return {
    health: provider.health,
    async search(input: FlightQuery): Promise<SearchResult> {
      const parsed = QuerySchema.safeParse(input);
      if (!parsed.success) throw new TrackerError("invalid_request");
      if (closed) throw new TrackerError("temporarily_unavailable");
      const query = parsed.data,
        key = queryKey(query),
        now = mono(),
        cached = cache.get(key);
      if (cached && cached.expires > now) return served(cached.result);
      const fallback = (error: TrackerError): SearchResult => {
        if (
          cached &&
          mono() - cached.written <= CACHE.staleMs &&
          [
            "provider_unavailable",
            "temporarily_unavailable",
            "rate_limited",
          ].includes(error.code)
        )
          return served(cached.result, true);
        throw error;
      };
      if (cooldown > now)
        return fallback(
          new TrackerError(
            "rate_limited",
            Math.max(1, Math.ceil((cooldown - now) / 1000)),
          ),
        );
      const previousError = errors.get(key);
      if (previousError && previousError.expires > now)
        return fallback(previousError.error);
      const inflight = pending.get(key);
      if (inflight) return structuredClone(await inflight);
      if (pending.size >= CACHE.maxConcurrent)
        return fallback(new TrackerError("temporarily_unavailable", 5));
      const controller = new AbortController();
      controllers.add(controller);
      let timeout: ReturnType<typeof setTimeout>;
      let abort: () => void;
      const promise = (async () => {
        try {
          const deadline = new Promise<never>((_, reject) => {
            abort = () =>
              reject(new TrackerError("temporarily_unavailable", 15));
            controller.signal.addEventListener("abort", abort, { once: true });
            timeout = setTimeout(() => {
              controller.abort();
              reject(new TrackerError("temporarily_unavailable", 15));
            }, options.timeoutMs ?? CACHE.timeoutMs);
            timeout.unref?.();
          });
          const result = SearchResultSchema.parse(
            await Promise.race([
              Promise.resolve().then(() =>
                provider.search(query, controller.signal),
              ),
              deadline,
            ]),
          );
          if (
            queryKey(result.query) !== key ||
            result.flights.some(
              (f) =>
                f.flight.requestedIdent !== query.flightNumber ||
                f.operatingDate !== query.date ||
                f.data.mode !== provider.health.mode ||
                f.data.provider !== provider.health.provider,
            )
          )
            throw new TrackerError("provider_unavailable");
          boundedSet(cache, key, {
            result,
            written: mono(),
            expires: mono() + cacheTtl(result),
          });
          errors.delete(key);
          return served(result);
        } catch (error) {
          const safe = publicError(error);
          if (safe.code === "rate_limited")
            cooldown = mono() + (safe.retryAfterSeconds ?? 60) * 1000;
          boundedSet(errors, key, {
            error: safe,
            expires: mono() + CACHE.errorMs,
          });
          // Definitive not-found invalidates previous data instead of resurrecting it later.
          if (safe.code === "flight_not_found") cache.delete(key);
          return fallback(safe);
        } finally {
          clearTimeout(timeout!);
          controller.signal.removeEventListener("abort", abort!);
          controllers.delete(controller);
          pending.delete(key);
        }
      })();
      pending.set(key, promise);
      return structuredClone(await promise);
    },
    close() {
      closed = true;
      for (const controller of controllers) controller.abort();
    },
    stats() {
      return { cached: cache.size, pending: pending.size, errors: errors.size };
    },
  };
}
export type TrackerService = ReturnType<typeof createTrackerService>;
