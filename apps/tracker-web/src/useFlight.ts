import { useCallback, useEffect, useRef, useState } from "react";
import {
  pollInterval,
  type FlightQuery,
  type SearchResult,
} from "../../tracker-shared/contracts";
import { ApiError, searchFlight } from "./api";

export function useFlight(query: FlightQuery | null) {
  const [result, setResult] = useState<SearchResult | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<ApiError | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    setResult(null);
    setError(null);
    setLoading(Boolean(query));
    if (!query) {
      refreshRef.current = () => {};
      return;
    }
    let disposed = false,
      running = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      requestTimer: ReturnType<typeof setTimeout> | undefined,
      active: AbortController | null = null,
      latest: SearchResult | null = null,
      retryUntil = 0;
    const refresh = async () => {
      if (disposed || running || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      const remaining = retryUntil - performance.now();
      if (remaining > 0) {
        timer = setTimeout(() => void refresh(), remaining);
        return;
      }
      running = true;
      active = new AbortController();
      setLoading(true);
      const controller = active;
      requestTimer = setTimeout(() => controller.abort(), 18_000);
      try {
        const data = await searchFlight(query, controller.signal);
        if (disposed) return;
        latest = data;
        setResult(data);
        setError(null);
      } catch (cause) {
        if (disposed) return;
        const failure =
          cause instanceof ApiError
            ? cause
            : new ApiError(
                "provider_unavailable",
                "We couldn't refresh flight data. Check your connection and try again.",
              );
        setError(failure);
        retryUntil =
          performance.now() + (failure.retryAfterSeconds ?? 30) * 1000;
        if (latest) {
          if (
            failure.code === "flight_not_found" ||
            failure.code === "invalid_request"
          ) {
            latest = null;
            setResult(null);
          } else {
            latest = structuredClone(latest);
            for (const f of latest.flights) f.data.stale = true;
            setResult(latest);
          }
        }
      } finally {
        clearTimeout(requestTimer);
        running = false;
        if (!disposed) {
          setLoading(false);
          timer = setTimeout(
            () => void refresh(),
            Math.max(
              pollInterval(latest?.flights[0]),
              retryUntil - performance.now(),
            ),
          );
        }
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "hidden") void refresh();
    };
    refreshRef.current = () => {
      void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(requestTimer);
      active?.abort();
      document.removeEventListener("visibilitychange", visibility);
      refreshRef.current = () => {};
    };
  }, [query?.flightNumber, query?.date]);
  return {
    result,
    loading,
    error,
    refresh: useCallback(() => refreshRef.current(), []),
  };
}
