import type { FlightOffer, ProviderSearchResult, SearchRequest } from "@flightbrain/domain";

export type ProviderCapabilities = {
  cashSearch: boolean;
  awardSearch: boolean;
  revalidation: boolean;
  booking: boolean;
  flexibleDates: boolean;
};

export interface FlightProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  search(request: SearchRequest, signal: AbortSignal): Promise<FlightOffer[]>;
  revalidate?(offer: FlightOffer, signal: AbortSignal): Promise<FlightOffer>;
}

export async function runProvider(
  provider: FlightProvider,
  request: SearchRequest,
  timeoutMs = 8_000,
): Promise<ProviderSearchResult> {
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const offers = await provider.search(request, controller.signal);
    return {
      provider: provider.id,
      offers,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "success",
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      provider: provider.id,
      offers: [],
      startedAt,
      finishedAt: new Date().toISOString(),
      status: timedOut ? "timeout" : "error",
      errorCode: error instanceof Error ? error.name : "UNKNOWN",
    };
  } finally {
    clearTimeout(timer);
  }
}
