import { createDemoProvider } from "../../apps/tracker-server/demo";
import type {
  FlightQuery,
  SearchResult,
} from "../../apps/tracker-shared/contracts";
export const NOW = Date.parse("2026-11-01T18:00:00.123Z");
export const QUERY: FlightQuery = { flightNumber: "RM104", date: "2026-11-01" };
export async function demoResult(query = QUERY): Promise<SearchResult> {
  return createDemoProvider(() => NOW).search(
    query,
    new AbortController().signal,
  );
}
export const response = (
  value: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
