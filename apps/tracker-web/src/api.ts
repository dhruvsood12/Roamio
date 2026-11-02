import {
  ErrorResponseSchema,
  SearchResultSchema,
  HealthSchema,
  type FlightQuery,
  type ErrorCode,
} from "../../tracker-shared/contracts";
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}
export async function searchFlight(query: FlightQuery, signal: AbortSignal) {
  const response = await fetch(
    `/api/flights/${encodeURIComponent(query.flightNumber)}?date=${query.date}`,
    { signal, headers: { Accept: "application/json" } },
  );
  const json: unknown = await response.json();
  if (!response.ok) {
    const error = ErrorResponseSchema.parse(json).error;
    throw new ApiError(error.code, error.message, error.retryAfterSeconds);
  }
  const result = SearchResultSchema.parse(json);
  if (
    result.query.flightNumber !== query.flightNumber ||
    result.query.date !== query.date
  )
    throw new Error("Mismatched flight response");
  return result;
}
export async function getHealth(signal: AbortSignal) {
  const response = await fetch("/api/health", { signal });
  if (!response.ok) throw new Error("Service unavailable");
  return HealthSchema.parse(await response.json());
}
