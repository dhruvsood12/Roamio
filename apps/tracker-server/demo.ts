import {
  SearchResultSchema,
  dateAt,
  delayMinutes,
  type FlightSnapshot,
  type FlightStatus,
} from "../tracker-shared/contracts";
import { TrackerError, iso, type StatusProvider } from "./provider";

export const DEMO_EXAMPLES = [
  ["RM101", "Scheduled"],
  ["RM102", "Delayed"],
  ["RM103", "Boarding"],
  ["RM104", "In air"],
  ["RM105", "Landed"],
  ["RM106", "Cancelled"],
  ["RM107", "Diverted"],
  ["RM108", "Gate unknown"],
  ["RM109", "No position"],
  ["RM110", "Stale data"],
  ["RM111", "Arrived"],
].map(([flightNumber, label]) => ({ flightNumber, label }));
const statuses: FlightStatus[] = [
  "scheduled",
  "delayed",
  "boarding",
  "in_air",
  "landed",
  "cancelled",
  "diverted",
  "scheduled",
  "in_air",
  "in_air",
  "arrived",
];

/** Synthetic Roamio examples, not captured provider responses. Stable schedules per server session. */
export function createDemoProvider(clock = Date.now): StatusProvider {
  const epoch = clock();
  return {
    health: {
      mode: "demo",
      provider: "roamio_demo",
      configured: true,
      examples: DEMO_EXAMPLES,
    },
    async search(query, signal) {
      if (signal.aborted) throw new TrackerError("temporarily_unavailable");
      if (query.flightNumber === "RM500")
        throw new TrackerError("provider_unavailable");
      if (query.flightNumber === "RM429")
        throw new TrackerError("rate_limited", 30);
      const index = DEMO_EXAMPLES.findIndex(
        (e) => e.flightNumber === query.flightNumber,
      );
      if (index < 0) throw new TrackerError("flight_not_found");
      const start = clock(),
        status = statuses[index];
      const moving = ["in_air", "landed", "arrived", "diverted"].includes(
        status,
      );
      const finished = status === "landed" || status === "arrived";
      // Deterministic given the injected clock/session epoch and query. All facts remain DEMO.
      const reference =
        Date.parse(`${query.date}T00:00:00Z`) + (epoch % 86_400_000);
      let dep =
        reference +
        (finished ? -7 : moving ? -2 : status === "boarding" ? 0.25 : 2) *
          3_600_000;
      // Keep every selected scenario on its requested origin-local operating date.
      if (dateAt(iso(dep), "America/Los_Angeles") < query.date)
        dep += 86_400_000;
      else if (dateAt(iso(dep), "America/Los_Angeles") > query.date)
        dep -= 86_400_000;
      const arr = dep + 5.5 * 3_600_000;
      const late = status === "delayed" ? 45 : moving ? 18 : 0;
      const shift = late * 60_000;
      const retrieved = Math.max(start, clock());
      const stale = query.flightNumber === "RM110";
      const snapshot: FlightSnapshot = {
        id: `demo:${query.flightNumber}:${query.date}`,
        flight: {
          ident: query.flightNumber,
          requestedIdent: query.flightNumber,
          operatingCarrier: "Roamio Demo",
          operatingFlightNumber: query.flightNumber.slice(2),
        },
        operatingDate: query.date,
        dateBasis: "origin_local",
        origin: {
          airportCode: "SFO",
          name: "San Francisco International",
          city: "San Francisco",
          timezone: "America/Los_Angeles",
          terminal: "3",
          gate: index === 7 ? null : "F12",
          coordinates: { latitude: 37.619, longitude: -122.375 },
        },
        destination: {
          airportCode: status === "diverted" ? "BOS" : "JFK",
          name:
            status === "diverted"
              ? "Boston Logan International"
              : "John F. Kennedy International",
          city: status === "diverted" ? "Boston" : "New York",
          timezone: "America/New_York",
          terminal: "4",
          gate: index === 7 ? null : "B32",
          coordinates:
            status === "diverted"
              ? { latitude: 42.365, longitude: -71.01 }
              : { latitude: 40.641, longitude: -73.778 },
        },
        scheduled: { departure: iso(dep), arrival: iso(arr) },
        estimated: {
          departure: status === "cancelled" ? null : iso(dep + shift),
          arrival: status === "cancelled" ? null : iso(arr + shift),
        },
        actual: {
          departure: moving ? iso(dep + shift) : null,
          arrival: status === "arrived" ? iso(arr + shift) : null,
        },
        runway: {
          takeoffAt: moving ? iso(dep + shift + 12 * 60_000) : null,
          landingAt: finished ? iso(arr + shift - 8 * 60_000) : null,
        },
        status,
        delayMinutes: {
          departure:
            status === "cancelled"
              ? null
              : delayMinutes(iso(dep), iso(dep + shift)),
          arrival:
            status === "cancelled"
              ? null
              : delayMinutes(iso(arr), iso(arr + shift)),
        },
        aircraft: {
          registration: "DEMO-01",
          type: "A321",
          model: "Airbus A321 · synthetic example",
        },
        position:
          moving && !finished && index !== 8
            ? {
                latitude: 41.3,
                longitude: -102.2,
                altitudeFeet: 35000,
                groundspeedKnots: 462,
                headingDegrees: 82,
                observedAt: iso(retrieved - (stale ? 25 * 60_000 : 25_000)),
              }
            : null,
        data: {
          provider: "roamio_demo",
          requestStartedAt: iso(start),
          retrievedAt: iso(retrieved),
          providerUpdatedAt: iso(retrieved - (stale ? 25 * 60_000 : 5000)),
          stale,
          mode: "demo",
          notices: [],
        },
      };
      return SearchResultSchema.parse({
        query,
        flights: [snapshot],
        coverage: "complete",
        servedAt: iso(retrieved),
      });
    },
  };
}
