import { createHash } from "node:crypto";
import { z } from "zod";
import {
  Instant,
  SearchResultSchema,
  SnapshotSchema,
  CoordinatesSchema,
  dateAt,
  delayMinutes,
  safeTimezone,
  type FlightQuery,
  type FlightSnapshot,
  type FlightStatus,
} from "../tracker-shared/contracts";
import { TrackerError, iso, type StatusProvider } from "./provider";

// Official AeroAPI OpenAPI 4.17.1. Unknown fields are discarded at this boundary.
const string = z.string().trim().min(1).max(160).nullish();
const time = Instant.nullish();
const Airport = z.object({
  code: string,
  code_iata: string,
  code_icao: string,
  name: string,
  city: string,
  timezone: string,
});
export const AeroFlightSchema = z.object({
  fa_flight_id: z.string().min(1).max(200),
  ident: z.string().min(1).max(40),
  ident_iata: string,
  ident_icao: string,
  operator: string,
  operator_iata: string,
  operator_icao: string,
  flight_number: string,
  codeshares: z.array(z.string().max(40)).max(100).nullish(),
  codeshares_iata: z.array(z.string().max(40)).max(100).nullish(),
  origin: Airport.nullable(),
  destination: Airport.nullable(),
  blocked: z.boolean(),
  cancelled: z.boolean(),
  diverted: z.boolean(),
  status: z.string().max(200),
  scheduled_out: time,
  scheduled_off: time,
  scheduled_in: time,
  estimated_out: time,
  estimated_in: time,
  actual_out: time,
  actual_off: time,
  actual_on: time,
  actual_in: time,
  gate_origin: string,
  gate_destination: string,
  terminal_origin: string,
  terminal_destination: string,
  aircraft_type: string,
  registration: string,
});
type AeroFlight = z.infer<typeof AeroFlightSchema>;
const FlightList = z.object({
  flights: z.array(AeroFlightSchema).max(1000),
  links: z.object({ next: z.string().nullable() }).nullable(),
  num_pages: z.number().int().min(0),
});
const Position = z.object({
  last_position: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      altitude: z.number().int(),
      groundspeed: z.number().int().nonnegative(),
      heading: z.number().min(0).max(360).nullable(),
      timestamp: Instant,
    })
    .nullable(),
});

export function normalizeStatus(f: AeroFlight): FlightStatus {
  const status = f.status.trim().toLowerCase();
  if (/^(cancelled|canceled)(?:\s|$)/.test(status)) return "cancelled";
  if (f.diverted) return "diverted";
  if (f.actual_in) return "arrived";
  if (f.actual_on) return "landed";
  // The cancellation flag alone means tracking stopped, not necessarily airline cancellation.
  if (f.cancelled) return "unknown";
  if (f.actual_off) return "in_air";
  if (f.actual_out) return "departed";
  if (status === "boarding") return "boarding";
  if ((delayMinutes(f.scheduled_out ?? null, f.estimated_out ?? null) ?? 0) > 0)
    return "delayed";
  if (/^scheduled(?:\s|$)/.test(status)) return "scheduled";
  if (/^delayed(?:\s|$)/.test(status)) return "delayed";
  return "unknown";
}
function airport(
  value: AeroFlight["origin"],
  terminal: string | null | undefined,
  gate: string | null | undefined,
): FlightSnapshot["origin"] {
  return {
    airportCode: value?.code_iata ?? value?.code_icao ?? value?.code ?? null,
    name: value?.name ?? null,
    city: value?.city ?? null,
    timezone: safeTimezone(value?.timezone ?? null),
    terminal: terminal ?? null,
    gate: gate ?? null,
    coordinates: null,
  };
}
export function mapFlight(
  f: AeroFlight,
  query: FlightQuery,
  startedAt: number,
  retrievedAt: number,
  occurrence = 0,
): FlightSnapshot {
  const origin = airport(f.origin, f.terminal_origin, f.gate_origin),
    destination = airport(
      f.destination,
      f.terminal_destination,
      f.gate_destination,
    );
  return SnapshotSchema.parse({
    // A diversion may reuse the provider flight ID; never collapse its separate legs.
    id: createHash("sha256")
      .update(
        JSON.stringify([
          f.fa_flight_id,
          f.origin?.code,
          f.destination?.code,
          f.scheduled_out,
          f.scheduled_off,
          occurrence,
        ]),
      )
      .digest("hex"),
    flight: {
      ident: f.ident_iata ?? f.ident_icao ?? f.ident,
      requestedIdent: query.flightNumber,
      operatingCarrier:
        f.operator_iata ?? f.operator_icao ?? f.operator ?? null,
      operatingFlightNumber: f.flight_number ?? null,
    },
    operatingDate: query.date,
    dateBasis: origin.timezone ? "origin_local" : "utc_fallback",
    origin,
    destination,
    scheduled: {
      departure: f.scheduled_out ?? null,
      arrival: f.scheduled_in ?? null,
    },
    estimated: {
      departure: f.estimated_out ?? null,
      arrival: f.estimated_in ?? null,
    },
    actual: { departure: f.actual_out ?? null, arrival: f.actual_in ?? null },
    runway: { takeoffAt: f.actual_off ?? null, landingAt: f.actual_on ?? null },
    status: normalizeStatus(f),
    delayMinutes: {
      departure: delayMinutes(
        f.scheduled_out ?? null,
        f.actual_out ?? f.estimated_out ?? null,
      ),
      arrival: delayMinutes(
        f.scheduled_in ?? null,
        f.actual_in ?? f.estimated_in ?? null,
      ),
    },
    aircraft: {
      registration: f.registration ?? null,
      type: f.aircraft_type ?? null,
      model: null,
    },
    position: null,
    data: {
      provider: "flightaware",
      requestStartedAt: iso(startedAt),
      retrievedAt: iso(Math.max(startedAt, retrievedAt)),
      providerUpdatedAt: null,
      stale: false,
      mode: "live",
      notices: [
        ...(f.cancelled ? ["tracking_stopped"] : []),
        ...(!origin.timezone || !destination.timezone
          ? ["timezone_unknown"]
          : []),
      ],
    },
  });
}
export function dateWindow(
  date: string,
  now: number,
): { start: number; end: number; limited: boolean } {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  // Covers every origin-local calendar date, including UTC+14 and UTC-12.
  const wantedStart = midnight - 14 * 3_600_000,
    wantedEnd = midnight + 36 * 3_600_000;
  const start = Math.max(wantedStart, now - 10 * 86_400_000),
    end = Math.min(wantedEnd, now + 2 * 86_400_000);
  if (start >= end) throw new TrackerError("invalid_request");
  return { start, end, limited: start !== wantedStart || end !== wantedEnd };
}
export function createFlightAwareProvider(
  apiKey: string | undefined,
  options: {
    fetch?: typeof fetch;
    clock?: () => number;
    monotonic?: () => number;
  } = {},
): StatusProvider {
  const transport = options.fetch ?? fetch,
    clock = options.clock ?? Date.now,
    monotonic = options.monotonic ?? (() => performance.now());
  let cooldownUntil = 0;
  const airports = new Map<
    string,
    { value: z.infer<typeof CoordinatesSchema>; expires: number }
  >();
  const airportRequests = new Map<
    string,
    Promise<z.infer<typeof CoordinatesSchema>>
  >();
  async function json(path: string, signal: AbortSignal): Promise<unknown> {
    if (!apiKey?.trim()) throw new TrackerError("provider_unavailable");
    if (monotonic() < cooldownUntil)
      throw new TrackerError(
        "rate_limited",
        Math.max(1, Math.ceil((cooldownUntil - monotonic()) / 1000)),
      );
    try {
      const response = await transport(
        `https://aeroapi.flightaware.com/aeroapi${path}`,
        {
          headers: { "x-apikey": apiKey, Accept: "application/json" },
          redirect: "error",
          signal,
        },
      );
      if (response.status === 429) {
        const raw = response.headers.get("retry-after"),
          seconds =
            raw && /^\d+$/.test(raw)
              ? Number(raw)
              : raw
                ? Math.ceil((Date.parse(raw) - clock()) / 1000)
                : 60;
        const retry = Number.isFinite(seconds)
          ? Math.max(1, Math.min(3600, seconds))
          : 60;
        cooldownUntil = monotonic() + retry * 1000;
        await response.body?.cancel();
        throw new TrackerError("rate_limited", retry);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new TrackerError(
          response.status === 404 ? "flight_not_found" : "provider_unavailable",
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new TrackerError("provider_unavailable");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2_000_000) {
            await reader.cancel();
            throw new TrackerError("provider_unavailable");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      throw error instanceof TrackerError
        ? error
        : new TrackerError("provider_unavailable");
    }
  }
  async function coordinates(code: string, signal: AbortSignal) {
    const cached = airports.get(code);
    if (cached && cached.expires > monotonic()) return cached.value;
    const pending = airportRequests.get(code);
    if (pending) return pending;
    const promise = (async () => {
      const raw = await json(`/airports/${encodeURIComponent(code)}`, signal);
      const value = CoordinatesSchema.parse(
        z.object({ latitude: z.number(), longitude: z.number() }).parse(raw),
      );
      if (airports.size >= 128) airports.delete(airports.keys().next().value!);
      airports.set(code, { value, expires: monotonic() + 86_400_000 });
      return value;
    })();
    airportRequests.set(code, promise);
    try {
      return await promise;
    } finally {
      airportRequests.delete(code);
    }
  }
  return {
    health: {
      mode: "live",
      provider: "flightaware",
      configured: Boolean(apiKey?.trim()),
      examples: [],
    },
    async search(query, signal) {
      const startedAt = clock(),
        window = dateWindow(query.date, startedAt);
      const params = new URLSearchParams({
        ident_type: "designator",
        start: iso(window.start),
        end: iso(window.end),
        max_pages: "1",
      });
      let payload: z.infer<typeof FlightList>;
      try {
        payload = FlightList.parse(
          await json(
            `/flights/${encodeURIComponent(query.flightNumber)}?${params}`,
            signal,
          ),
        );
      } catch (error) {
        throw error instanceof TrackerError
          ? error
          : new TrackerError("provider_unavailable");
      }
      let dateUnresolved = false;
      const matches = payload.flights.filter((f) => {
        const identities = [
          f.ident,
          f.ident_iata,
          f.ident_icao,
          ...(f.codeshares ?? []),
          ...(f.codeshares_iata ?? []),
        ];
        if (
          f.blocked ||
          !identities.some((v) => v?.toUpperCase() === query.flightNumber)
        )
          return false;
        const departure = f.scheduled_out ?? f.scheduled_off;
        if (!departure) {
          dateUnresolved = true;
          return false;
        }
        return dateAt(departure, f.origin?.timezone ?? null) === query.date;
      });
      const limited =
        window.limited ||
        Boolean(payload.links?.next) ||
        dateUnresolved ||
        matches.length > 20;
      if (!matches.length)
        throw new TrackerError(
          limited ? "temporarily_unavailable" : "flight_not_found",
        );
      const flights = matches
        .slice(0, 20)
        .map((f, index) => mapFlight(f, query, startedAt, clock(), index));
      // Bounded optional enrichment: first match only, at most two airport calls + one position.
      // Other matches still retain all schedule/status facts and can be selected without guessing.
      const first = flights[0],
        raw = matches[0];
      if (
        ["in_air", "departed", "diverted"].includes(first.status) &&
        !raw.actual_on &&
        !raw.actual_in
      ) {
        try {
          const p = Position.parse(
            await json(
              `/flights/${encodeURIComponent(raw.fa_flight_id)}/position`,
              AbortSignal.any([signal, AbortSignal.timeout(2000)]),
            ),
          ).last_position;
          if (p)
            first.position = {
              latitude: p.latitude,
              longitude: p.longitude,
              altitudeFeet: p.altitude * 100,
              groundspeedKnots: p.groundspeed,
              headingDegrees: p.heading,
              observedAt: p.timestamp,
            };
        } catch {
          first.data.notices.push("position_unavailable");
        }
      }
      // Airport coordinates are only useful when there is a position to map.
      if (first.position) {
        for (const side of ["origin", "destination"] as const) {
          const code = raw[side]?.code_icao ?? raw[side]?.code_iata;
          if (code && /^[A-Z0-9]{3,4}$/.test(code)) {
            try {
              first[side].coordinates = await coordinates(
                code,
                AbortSignal.any([signal, AbortSignal.timeout(2000)]),
              );
            } catch {
              /* Map enrichment never hides usable status. */
            }
          }
        }
      }
      const completed = Math.max(startedAt, clock());
      for (const f of flights) {
        f.data.retrievedAt = iso(completed);
        if (limited) f.data.notices.push("partial_coverage");
      }
      return SearchResultSchema.parse({
        query,
        flights,
        coverage: limited ? "limited" : "complete",
        servedAt: iso(completed),
      });
    },
  };
}
