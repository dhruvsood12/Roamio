import {
  QuerySchema,
  queryKey,
  type FlightQuery,
} from "../../tracker-shared/contracts";

export const STORAGE = {
  saved: "roamio.tracker.saved.v1",
  recent: "roamio.tracker.recent.v1",
} as const;
export function readFlights(kind: keyof typeof STORAGE): FlightQuery[] {
  try {
    const raw = localStorage.getItem(STORAGE[kind]);
    if (!raw || raw.length > 16_000) return [];
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    const seen = new Set<string>(),
      result: FlightQuery[] = [];
    for (const value of values.slice(0, 100)) {
      const p = QuerySchema.safeParse(value);
      if (p.success && !seen.has(queryKey(p.data))) {
        seen.add(queryKey(p.data));
        result.push(p.data);
      }
    }
    return result.slice(0, kind === "saved" ? 20 : 8);
  } catch {
    return [];
  }
}
export function writeFlights(
  kind: keyof typeof STORAGE,
  values: FlightQuery[],
): boolean {
  try {
    const safe = values
      .slice(0, kind === "saved" ? 20 : 8)
      .map((v) => QuerySchema.parse(v));
    localStorage.setItem(STORAGE[kind], JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}
export function remember(
  list: FlightQuery[],
  query: FlightQuery,
  limit: number,
): FlightQuery[] {
  return [query, ...list.filter((q) => queryKey(q) !== queryKey(query))].slice(
    0,
    limit,
  );
}
