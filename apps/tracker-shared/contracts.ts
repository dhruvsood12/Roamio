import { z } from "zod";

export const Instant = z.iso
  .datetime({ offset: true })
  .regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((v) => !v.endsWith("-00:00") && Number.isFinite(Date.parse(v)));
const text = z.string().trim().min(1).max(160);
export const FlightNumber = z
  .string()
  .max(24)
  .transform((v) => v.trim().toUpperCase().replace(/\s+/g, ""))
  .pipe(
    z.string().regex(/^(?:[A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z])\d{1,4}[A-Z]?$/),
  );
const OperatingDate = z.iso
  .date()
  .refine(
    (v) => v >= "1900-01-01" && v <= "2100-12-31",
    "Use an operating date between 1900 and 2100",
  );
export const QuerySchema = z.strictObject({
  flightNumber: FlightNumber,
  date: OperatingDate,
});
export type FlightQuery = z.infer<typeof QuerySchema>;
export const StatusSchema = z.enum([
  "scheduled",
  "boarding",
  "departed",
  "in_air",
  "landed",
  "arrived",
  "cancelled",
  "diverted",
  "delayed",
  "unknown",
]);
export type FlightStatus = z.infer<typeof StatusSchema>;
export const CoordinatesSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export const AirportSchema = z.strictObject({
  airportCode: text.nullable(),
  name: text.nullable(),
  city: text.nullable(),
  timezone: text.nullable(),
  terminal: text.nullable(),
  gate: text.nullable(),
  coordinates: CoordinatesSchema.nullable(),
});
const pair = z.strictObject({
  departure: Instant.nullable(),
  arrival: Instant.nullable(),
});
export const SnapshotSchema = z
  .strictObject({
    id: z.string().min(1).max(300),
    flight: z.strictObject({
      ident: text,
      requestedIdent: FlightNumber,
      operatingCarrier: text.nullable(),
      operatingFlightNumber: text.nullable(),
    }),
    operatingDate: OperatingDate,
    dateBasis: z.enum(["origin_local", "utc_fallback"]),
    origin: AirportSchema,
    destination: AirportSchema,
    scheduled: pair,
    estimated: pair,
    actual: pair,
    runway: z.strictObject({
      takeoffAt: Instant.nullable(),
      landingAt: Instant.nullable(),
    }),
    status: StatusSchema,
    delayMinutes: z.strictObject({
      departure: z.number().int().nullable(),
      arrival: z.number().int().nullable(),
    }),
    aircraft: z.strictObject({
      registration: text.nullable(),
      type: text.nullable(),
      model: text.nullable(),
    }),
    position: CoordinatesSchema.extend({
      altitudeFeet: z.number().finite().nullable(),
      groundspeedKnots: z.number().nonnegative().nullable(),
      headingDegrees: z.number().min(0).max(360).nullable(),
      observedAt: Instant,
    }).nullable(),
    data: z.strictObject({
      provider: z.enum(["flightaware", "roamio_demo"]),
      requestStartedAt: Instant,
      retrievedAt: Instant,
      providerUpdatedAt: Instant.nullable(),
      stale: z.boolean(),
      mode: z.enum(["live", "demo"]),
      notices: z
        .array(
          z.enum([
            "tracking_stopped",
            "position_unavailable",
            "partial_coverage",
            "timezone_unknown",
            "refresh_failed",
          ]),
        )
        .max(5),
    }),
  })
  .superRefine((v, ctx) => {
    if (Date.parse(v.data.retrievedAt) < Date.parse(v.data.requestStartedAt))
      ctx.addIssue({
        code: "custom",
        path: ["data", "retrievedAt"],
        message: "Retrieval precedes local request start",
      });
    if ((v.data.mode === "demo") !== (v.data.provider === "roamio_demo"))
      ctx.addIssue({
        code: "custom",
        path: ["data", "mode"],
        message: "Provider/mode mismatch",
      });
    for (const kind of ["scheduled", "estimated", "actual"] as const) {
      const p = v[kind];
      if (
        p.departure &&
        p.arrival &&
        Date.parse(p.arrival) < Date.parse(p.departure)
      )
        ctx.addIssue({
          code: "custom",
          path: [kind],
          message: "Arrival precedes departure",
        });
    }
    const actualEvents = [
      v.actual.departure,
      v.runway.takeoffAt,
      v.runway.landingAt,
      v.actual.arrival,
    ]
      .filter((t): t is string => t !== null)
      .map(Date.parse);
    if (actualEvents.some((time, i) => i > 0 && time < actualEvents[i - 1]))
      ctx.addIssue({
        code: "custom",
        path: ["actual"],
        message: "Actual movement events contradict flight order",
      });
  });
export type FlightSnapshot = z.infer<typeof SnapshotSchema>;
export const SearchResultSchema = z.strictObject({
  query: QuerySchema,
  flights: z.array(SnapshotSchema).min(1).max(20),
  coverage: z.enum(["complete", "limited"]),
  servedAt: Instant,
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
export const ErrorCodeSchema = z.enum([
  "invalid_request",
  "flight_not_found",
  "provider_unavailable",
  "rate_limited",
  "temporarily_unavailable",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: text,
    retryAfterSeconds: z.number().int().min(1).max(3600).nullable(),
  }),
});
export const HealthSchema = z.strictObject({
  mode: z.enum(["live", "demo"]),
  provider: z.enum(["flightaware", "roamio_demo"]),
  configured: z.boolean(),
  examples: z.array(
    z.strictObject({ flightNumber: FlightNumber, label: text }),
  ),
});
export type Health = z.infer<typeof HealthSchema>;

export const FRESHNESS_MS = {
  retrieval: 5 * 60_000,
  source: 5 * 60_000,
  position: 2 * 60_000,
  clockTolerance: 60_000,
} as const;
export function isStale(f: FlightSnapshot, now: number): boolean {
  const ages = [
    now - Date.parse(f.data.retrievedAt),
    ...(f.data.providerUpdatedAt
      ? [now - Date.parse(f.data.providerUpdatedAt)]
      : []),
  ];
  return (
    f.data.stale ||
    ages.some(
      (age) => age > FRESHNESS_MS.source || age < -FRESHNESS_MS.clockTolerance,
    )
  );
}
export function freshness(
  f: FlightSnapshot,
  now: number,
): "DEMO" | "STALE" | "LIVE" | "RECENT" {
  if (f.data.mode === "demo") return "DEMO";
  if (isStale(f, now)) return "STALE";
  // Position age never establishes freshness of the rest of the flight's status.
  return f.data.providerUpdatedAt &&
    now - Date.parse(f.data.providerUpdatedAt) <= FRESHNESS_MS.position
    ? "LIVE"
    : "RECENT";
}
export function delayMinutes(
  scheduled: string | null,
  actualOrEstimated: string | null,
): number | null {
  return scheduled && actualOrEstimated
    ? Math.trunc(
        (Date.parse(actualOrEstimated) - Date.parse(scheduled)) / 60_000,
      )
    : null;
}
export function safeTimezone(zone: string | null): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
    return zone;
  } catch {
    return null;
  }
}
export function dateAt(instant: string, zone: string | null): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimezone(zone) ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  return ["year", "month", "day"]
    .map((k) => parts.find((p) => p.type === k)!.value)
    .join("-");
}
export function timeLabel(instant: string | null, zone: string | null): string {
  if (!instant) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimezone(zone) ?? "UTC",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(instant));
}
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export const queryKey = (q: FlightQuery): string =>
  `${q.flightNumber}/${q.date}`;
export const flightPath = (q: FlightQuery): string =>
  `/flight/${encodeURIComponent(q.flightNumber)}/${q.date}`;
export function parseFlightPath(path: string): FlightQuery | null {
  try {
    const match = /^\/flight\/([^/]+)\/([^/]+)\/?$/.exec(path);
    return match
      ? QuerySchema.parse({
          flightNumber: decodeURIComponent(match[1]),
          date: match[2],
        })
      : null;
  } catch {
    return null;
  }
}
export function pollInterval(f: FlightSnapshot | undefined): number {
  if (!f) return 60_000;
  if (f.data.mode === "demo") return 15_000;
  if (["arrived", "landed", "cancelled"].includes(f.status)) return 300_000;
  if (["in_air", "departed", "boarding", "diverted"].includes(f.status))
    return 30_000;
  return 120_000;
}
export function progress(
  f: FlightSnapshot,
  now: number,
): { fraction: number; label: string } {
  if (["landed", "arrived"].includes(f.status))
    return {
      fraction: 1,
      label:
        f.status === "arrived"
          ? "At the arrival gate"
          : "Landed · awaiting gate arrival",
    };
  if (
    ["in_air", "departed", "diverted"].includes(f.status) &&
    f.actual.departure &&
    f.estimated.arrival
  ) {
    const start = Date.parse(f.actual.departure),
      end = Date.parse(f.estimated.arrival);
    if (end > start)
      return {
        fraction: Math.max(0, Math.min(1, (now - start) / (end - start))),
        label: "Time-based estimate · not aircraft location",
      };
  }
  return {
    fraction: 0,
    label:
      f.status === "cancelled"
        ? "Flight cancelled"
        : "Progress unavailable until departure and arrival estimates are known",
  };
}
