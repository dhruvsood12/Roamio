import type {
  ErrorCode,
  FlightQuery,
  SearchResult,
  Health,
} from "../tracker-shared/contracts";

const messages: Record<ErrorCode, string> = {
  invalid_request: "Check the flight number and operating date and try again.",
  flight_not_found: "We couldn't find a matching flight for this date.",
  provider_unavailable:
    "Flight data is temporarily unavailable. Please try again shortly.",
  rate_limited:
    "Flight updates are temporarily limited. Please wait before trying again.",
  temporarily_unavailable:
    "This flight can't be checked right now. Please try again shortly.",
};
export class TrackerError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(messages[code]);
  }
}
export interface StatusProvider {
  health: Health;
  search(query: FlightQuery, signal: AbortSignal): Promise<SearchResult>;
}
export const errorStatus: Record<ErrorCode, number> = {
  invalid_request: 400,
  flight_not_found: 404,
  provider_unavailable: 502,
  rate_limited: 429,
  temporarily_unavailable: 503,
};
export function publicError(error: unknown): TrackerError {
  return error instanceof TrackerError
    ? error
    : new TrackerError("provider_unavailable");
}
export const iso = (time: number): string => new Date(time).toISOString();
