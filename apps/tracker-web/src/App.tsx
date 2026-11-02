import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  QuerySchema,
  dateAt,
  flightPath,
  freshness,
  isStale,
  localToday,
  parseFlightPath,
  progress,
  queryKey,
  safeTimezone,
  timeLabel,
  type FlightQuery,
  type FlightSnapshot,
  type Health,
} from "../../tracker-shared/contracts";
import { getHealth, searchFlight } from "./api";
import { readFlights, remember, writeFlights } from "./storage";
import { useFlight } from "./useFlight";

export const STATUS: Record<FlightSnapshot["status"], string> = {
  scheduled: "Scheduled",
  boarding: "Boarding",
  departed: "Left the gate",
  in_air: "In the air",
  landed: "Landed",
  arrived: "Arrived",
  cancelled: "Cancelled",
  diverted: "Diverted",
  delayed: "Delayed",
  unknown: "Status unavailable",
};
function Icon({
  name,
  size = 20,
}: {
  name: "plane" | "plus" | "check" | "refresh" | "arrow" | "close" | "clock";
  size?: number;
}) {
  const paths = {
    plane: "m3 13 18-9-6 17-3-7-9-1Z",
    plus: "M12 5v14M5 12h14",
    check: "m5 12 4 4L19 6",
    refresh:
      "M20 7v5h-5M4 17v-5h5M5.5 8a7 7 0 0 1 12-3L20 8M4 16l2.5 3a7 7 0 0 0 12-3",
    arrow: "M4 12h16m-6-6 6 6-6 6",
    close: "m6 6 12 12M6 18 18 6",
    clock: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
const niceDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
export function ageLabel(instant: string, now: number): string {
  const seconds = Math.floor((now - Date.parse(instant)) / 1000);
  if (seconds < -60) return "timestamp ahead of local clock";
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
function delayLabel(minutes: number | null): string {
  return minutes === null
    ? "Delay unknown"
    : minutes === 0
      ? "On time"
      : minutes < 0
        ? `${Math.abs(minutes)} min early`
        : `${minutes} min late`;
}
function nextEvent(f: FlightSnapshot, now: number): string {
  if (f.status === "cancelled")
    return "Contact your airline for your travel options.";
  if (f.status === "arrived")
    return "Your flight has reached the arrival gate.";
  if (f.status === "landed")
    return "On the ground. Waiting for a gate-arrival update.";
  if (f.status === "diverted")
    return "Destination changed. Check with your airline for the latest guidance.";
  if (isStale(f, now))
    return "Waiting for a fresh update. Times below may have changed.";
  const moving = f.status === "in_air" || f.status === "departed";
  const target = moving
    ? f.estimated.arrival
    : (f.estimated.departure ?? f.scheduled.departure);
  if (!target)
    return moving
      ? "Arrival estimate not available yet."
      : "Waiting for the next flight update.";
  const mins = Math.ceil((Date.parse(target) - now) / 60_000);
  if (mins < 0)
    return moving
      ? "Arrival estimate has passed. Awaiting an update."
      : "Departure time has passed. Awaiting an update.";
  return `${moving ? "Estimated gate arrival" : f.estimated.departure ? "Estimated departure" : "Scheduled departure"} in ${mins >= 60 ? `${Math.floor(mins / 60)}h ` : ""}${mins % 60}m`;
}
function Freshness({ flight, now }: { flight: FlightSnapshot; now: number }) {
  const value = freshness(flight, now);
  return (
    <span className={`freshness ${value.toLowerCase()}`}>
      <i />
      {value}
      {value === "DEMO" && isStale(flight, now) ? " · STALE" : ""}
    </span>
  );
}

function PositionMap({
  flight: f,
  now,
}: {
  flight: FlightSnapshot;
  now: number;
}) {
  const p = f.position;
  const routeProgress = progress(f, now);
  if (!p)
    return (
      <section className="route-map no-position" aria-label="Flight progress">
        <div className="map-heading">
          <span>THE JOURNEY</span>
          <span>No aircraft position available</span>
        </div>
        <svg viewBox="0 0 640 200" aria-hidden="true">
          <path
            d="M65 160 Q320 -35 575 160"
            fill="none"
            stroke="#cbd8c2"
            strokeWidth="2"
            strokeDasharray="4 6"
          />
          <circle cx="65" cy="160" r="6" fill="#d5f5a6" />
          <circle cx="575" cy="160" r="6" fill="#d5f5a6" />
        </svg>
        <div className="route-labels">
          <b>{f.origin.airportCode ?? "Origin"}</b>
          <span>Flight status is still available</span>
          <b>{f.destination.airportCode ?? "Destination"}</b>
        </div>
        <div className="progress-rail" aria-label={routeProgress.label}>
          <span style={{ width: `${routeProgress.fraction * 100}%` }} />
        </div>
        <p className="map-foot">{routeProgress.label}</p>
      </section>
    );
  const points = [f.origin.coordinates, f.destination.coordinates, p].filter(
    (v) => v !== null,
  );
  const xs = points.map((v) => v.longitude + 180),
    ys = points.map((v) => 90 - v.latitude);
  const crossesDateLine = Math.max(...xs) - Math.min(...xs) > 180;
  let width = Math.max(50, Math.max(...xs) - Math.min(...xs) + 18),
    height = Math.max(25, Math.max(...ys) - Math.min(...ys) + 20);
  width = Math.max(width, height * 2.3);
  height = width / 2.3;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2,
    cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const viewBox = crossesDateLine
    ? "0 0 360 180"
    : `${cx - width / 2} ${cy - height / 2} ${width} ${height}`;
  const scale = (crossesDateLine ? 360 : width) / 480;
  const positionAge = now - Date.parse(p.observedAt);
  return (
    <section className="route-map" aria-label="Latest aircraft position">
      <div className="map-heading">
        <span>
          {f.data.mode === "demo"
            ? "SYNTHETIC POSITION"
            : positionAge > 120_000 || positionAge < -60_000
              ? "OLDER / UNCONFIRMED POSITION"
              : "LATEST POSITION"}
        </span>
        <span>{ageLabel(p.observedAt, now)}</span>
      </div>
      <svg
        className="geo-map"
        viewBox={viewBox}
        role="img"
        aria-label={`Aircraft at ${p.latitude.toFixed(2)} latitude, ${p.longitude.toFixed(2)} longitude`}
      >
        <image href="/world.svg" x="0" y="0" width="360" height="180" />
        {f.origin.coordinates &&
          f.destination.coordinates &&
          !crossesDateLine && (
            <line
              x1={f.origin.coordinates.longitude + 180}
              y1={90 - f.origin.coordinates.latitude}
              x2={f.destination.coordinates.longitude + 180}
              y2={90 - f.destination.coordinates.latitude}
              stroke="#eff8df"
              strokeWidth={scale * 1.3}
              strokeDasharray={`${scale * 4} ${scale * 4}`}
            />
          )}
        {[f.origin, f.destination].map(
          (a, i) =>
            a.coordinates && (
              <g key={i}>
                <circle
                  cx={a.coordinates.longitude + 180}
                  cy={90 - a.coordinates.latitude}
                  r={scale * 4}
                  fill="#243328"
                  stroke="#e7f9d1"
                  strokeWidth={scale * 2}
                />
                <text
                  x={a.coordinates.longitude + 180}
                  y={90 - a.coordinates.latitude + scale * 20}
                  textAnchor="middle"
                  fontSize={scale * 13}
                  fontWeight="700"
                  fill="#17271a"
                >
                  {a.airportCode}
                </text>
              </g>
            ),
        )}
        <g
          transform={`translate(${p.longitude + 180} ${90 - p.latitude}) scale(${scale})`}
        >
          <circle r="20" fill="#233529" />
          <g transform={`rotate(${(p.headingDegrees ?? 90) - 90})`}>
            <path
              d="m-11-2 7-2-2-9 4 1 6 8 9 3v2L4 4l-6 8-4 1 2-9-7-2Z"
              fill="#dbf3b4"
            />
          </g>
        </g>
      </svg>
      <div className="map-footer">
        <span>
          {p.altitudeFeet === null
            ? "Altitude unavailable"
            : `${p.altitudeFeet.toLocaleString()} ft`}
          {p.groundspeedKnots !== null ? ` · ${p.groundspeedKnots} kt` : ""}
        </span>
        <span>Direct route guide, not flown track</span>
      </div>
    </section>
  );
}
function TimeRow({
  label,
  value,
  scheduled,
  airport,
}: {
  label: string;
  value: string | null;
  scheduled: string | null;
  airport: FlightSnapshot["origin"];
}) {
  const changedDay =
    value &&
    scheduled &&
    dateAt(value, airport.timezone) !== dateAt(scheduled, airport.timezone);
  return (
    <div className="time-row">
      <span>{label}</span>
      <strong>
        {timeLabel(value, airport.timezone)}
        {changedDay && (
          <small>{niceDate(dateAt(value, airport.timezone))}</small>
        )}
      </strong>
    </div>
  );
}
function FlightView({
  flight: f,
  now,
  saved,
  onSave,
  loading,
  refresh,
}: {
  flight: FlightSnapshot;
  now: number;
  saved: boolean;
  onSave: () => void;
  loading: boolean;
  refresh: () => void;
}) {
  const departure =
      f.actual.departure ?? f.estimated.departure ?? f.scheduled.departure,
    arrival = f.actual.arrival ?? f.estimated.arrival ?? f.scheduled.arrival;
  return (
    <>
      <section className="flight-card" aria-label="Flight overview">
        <div className="flight-topline">
          <div className="carrier-mark">
            <Icon name="plane" size={24} />
          </div>
          <div>
            <span className="eyebrow">
              {f.flight.operatingCarrier ?? "Carrier unavailable"}
              {f.data.mode === "demo" ? " · Example flight" : ""}
            </span>
            <h2>{f.flight.ident}</h2>
          </div>
          <button
            className={`save-button ${saved ? "saved" : ""}`}
            onClick={onSave}
          >
            <Icon name={saved ? "check" : "plus"} />
            {saved ? "Tracking" : "Track flight"}
          </button>
        </div>
        {f.flight.ident !== f.flight.requestedIdent && (
          <p className="codeshare">
            Searched as {f.flight.requestedIdent} · provider matched{" "}
            {f.flight.ident}
          </p>
        )}
        <div className="flight-route">
          <div>
            <p>{f.origin.city ?? f.origin.name ?? "Origin unknown"}</p>
            <strong>{f.origin.airportCode ?? "—"}</strong>
            <span className="route-time">
              {timeLabel(departure, f.origin.timezone)}
            </span>
            <small>
              {f.actual.departure
                ? "Actual gate departure"
                : f.estimated.departure
                  ? "Estimated departure"
                  : "Scheduled departure"}
            </small>
          </div>
          <div className="route-divider">
            <span />
            <Icon name="plane" size={25} />
            <span />
          </div>
          <div>
            <p>
              {f.destination.city ??
                f.destination.name ??
                "Destination unknown"}
            </p>
            <strong>{f.destination.airportCode ?? "—"}</strong>
            <span className="route-time">
              {timeLabel(arrival, f.destination.timezone)}
            </span>
            {arrival &&
              dateAt(arrival, f.destination.timezone) !== f.operatingDate && (
                <span className="arrival-date">
                  {niceDate(dateAt(arrival, f.destination.timezone))} arrival
                </span>
              )}
            <small>
              {f.actual.arrival
                ? "Actual gate arrival"
                : f.estimated.arrival
                  ? "Estimated gate arrival"
                  : "Scheduled arrival"}
            </small>
          </div>
        </div>
        <div className={`status-strip status-${f.status}`}>
          <div>
            <span className="status-label">
              <i />
              {STATUS[f.status]}
            </span>
            <p>{nextEvent(f, now)}</p>
          </div>
          <span className="delay-label">
            {delayLabel(f.delayMinutes.arrival)}
          </span>
        </div>
        <div className="flight-footer">
          <div>
            <Freshness flight={f} now={now} />
            <span>Checked {ageLabel(f.data.retrievedAt, now)}</span>
          </div>
          <button className="text-button" disabled={loading} onClick={refresh}>
            <Icon name="refresh" size={16} />
            {loading ? "Updating…" : "Refresh"}
          </button>
        </div>
        {f.data.mode === "live" && !f.data.providerUpdatedAt && (
          <p className="source-note">
            Latest provider check shown. The provider does not timestamp this
            status update.
          </p>
        )}
      </section>
      <PositionMap flight={f} now={now} />
      <section className="timeline panel">
        <div className="section-title">
          <h3>Every moment, in view.</h3>
          <Icon name="clock" />
        </div>
        <p className="section-caption">
          Airport-local times
          {!f.origin.timezone || !f.destination.timezone
            ? " where available · UTC fallback is labelled"
            : ""}{" "}
          · gate to gate
        </p>
        <div className="timeline-columns">
          {(["departure", "arrival"] as const).map((side) => {
            const airport = side === "departure" ? f.origin : f.destination;
            return (
              <div key={side}>
                <div className="timeline-heading">
                  <span className="timeline-dot" />
                  <div>
                    <h4>
                      {side === "departure" ? "Departure" : "Arrival"}{" "}
                      <span>{airport.airportCode}</span>
                    </h4>
                    <p>{airport.name ?? "Airport name unavailable"}</p>
                    <small>
                      {f.scheduled[side]
                        ? niceDate(dateAt(f.scheduled[side]!, airport.timezone))
                        : "Date unavailable"}{" "}
                      ·{" "}
                      {safeTimezone(airport.timezone) ??
                        "UTC (airport timezone unknown)"}
                    </small>
                  </div>
                </div>
                <div className="timeline-times">
                  <TimeRow
                    label="Scheduled"
                    value={f.scheduled[side]}
                    scheduled={f.scheduled[side]}
                    airport={airport}
                  />
                  <TimeRow
                    label="Estimated"
                    value={f.estimated[side]}
                    scheduled={f.scheduled[side]}
                    airport={airport}
                  />
                  <TimeRow
                    label="Actual"
                    value={f.actual[side]}
                    scheduled={f.scheduled[side]}
                    airport={airport}
                  />
                  <p className="timeline-delay">
                    {delayLabel(f.delayMinutes[side])}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        <div className="runway-times">
          <span>
            Takeoff <b>{timeLabel(f.runway.takeoffAt, f.origin.timezone)}</b>
          </span>
          <span>
            Touchdown{" "}
            <b>{timeLabel(f.runway.landingAt, f.destination.timezone)}</b>
          </span>
        </div>
      </section>
      <section className="details panel">
        <h3>The finer details.</h3>
        <div className="gate-grid">
          <div>
            <span className="eyebrow">
              DEPARTURE · {f.origin.airportCode ?? "—"}
            </span>
            <div>
              <span>
                Terminal<strong>{f.origin.terminal ?? "—"}</strong>
              </span>
              <span>
                Gate<strong>{f.origin.gate ?? "—"}</strong>
              </span>
            </div>
          </div>
          <div>
            <span className="eyebrow">
              ARRIVAL · {f.destination.airportCode ?? "—"}
            </span>
            <div>
              <span>
                Terminal<strong>{f.destination.terminal ?? "—"}</strong>
              </span>
              <span>
                Gate<strong>{f.destination.gate ?? "—"}</strong>
              </span>
            </div>
          </div>
        </div>
        <div className="aircraft">
          <Icon name="plane" size={28} />
          <div>
            <span className="eyebrow">AIRCRAFT</span>
            <strong>
              {f.aircraft.model ?? f.aircraft.type ?? "Aircraft not available"}
            </strong>
            <p>Registration {f.aircraft.registration ?? "not available"}</p>
          </div>
        </div>
      </section>
    </>
  );
}
function SavedFlights({
  saved,
  active,
  activeFlight,
  now,
  open,
  remove,
}: {
  saved: FlightQuery[];
  active: FlightQuery | null;
  activeFlight: FlightSnapshot | undefined;
  now: number;
  open: (q: FlightQuery) => void;
  remove: (q: FlightQuery) => void;
}) {
  const [flights, setFlights] = useState<
    Record<string, FlightSnapshot | "unavailable" | "ambiguous">
  >({});
  useEffect(() => {
    let disposed = false,
      current: AbortController | undefined,
      deadline: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      for (const q of saved) {
        if (disposed) break;
        if (active && queryKey(q) === queryKey(active)) continue;
        const controller = new AbortController();
        current = controller;
        deadline = setTimeout(() => controller.abort(), 18_000);
        try {
          const result = await searchFlight(q, controller.signal);
          if (!disposed)
            setFlights((old) => ({
              ...old,
              [queryKey(q)]:
                result.flights.length > 1 ? "ambiguous" : result.flights[0],
            }));
        } catch {
          if (!disposed)
            setFlights((old) => ({ ...old, [queryKey(q)]: "unavailable" }));
        } finally {
          clearTimeout(deadline);
        }
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(deadline);
      current?.abort();
    };
  }, [JSON.stringify(saved), active?.flightNumber, active?.date]);
  return (
    <section className="my-flights" id="my-flights">
      <div className="section-title">
        <h3>
          My flights <span className="count">{saved.length}</span>
        </h3>
        <span>Saved on this device</span>
      </div>
      {saved.length ? (
        <div className="saved-grid">
          {saved.map((q) => {
            const f =
              active && queryKey(q) === queryKey(active)
                ? activeFlight
                : flights[queryKey(q)];
            return (
              <div className="saved-card" key={queryKey(q)}>
                <button className="saved-open" onClick={() => open(q)}>
                  <span className="saved-ident">
                    <Icon name="plane" />
                    <b>{q.flightNumber}</b>
                    <small>{niceDate(q.date)}</small>
                  </span>
                  <span>
                    {f && typeof f !== "string"
                      ? `${f.origin.airportCode ?? "—"} → ${f.destination.airportCode ?? "—"}`
                      : "Open flight details"}
                  </span>
                  <span className="saved-status">
                    {f && typeof f !== "string"
                      ? `${STATUS[f.status]} · ${freshness(f, now)}${f.data.mode === "demo" && isStale(f, now) ? " · STALE" : ""}`
                      : f === "unavailable"
                        ? "UNAVAILABLE · try again"
                        : f === "ambiguous"
                          ? "Multiple matches · choose a journey"
                          : "Checking status…"}
                  </span>
                </button>
                <button
                  className="remove-button"
                  aria-label={`Untrack ${q.flightNumber}`}
                  onClick={() => remove(q)}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="saved-empty">
          <Icon name="plane" />
          <p>
            Your next journey belongs here.
            <span>Track a flight to keep it close.</span>
          </p>
        </div>
      )}
    </section>
  );
}
function Skeleton() {
  return (
    <div className="loading-grid" role="status" aria-label="Loading flight">
      <div className="skeleton">
        <span />
        <span />
        <span />
      </div>
      <div className="skeleton map-skeleton" />
      <p>Finding your flight…</p>
    </div>
  );
}
function ErrorPanel({
  children,
  retry,
  title,
}: {
  children: ReactNode;
  retry: () => void;
  title: string;
}) {
  return (
    <div className="error-panel" role="alert">
      <span className="error-symbol">!</span>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
      <button className="secondary" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

export function App() {
  const trackerPanel = useRef<HTMLElement>(null);
  const revealFlight = useRef(true);
  const initial = useRef(parseFlightPath(window.location.pathname));
  const [query, setQuery] = useState<FlightQuery | null>(initial.current),
    [flightNumber, setFlightNumber] = useState(
      initial.current?.flightNumber ?? "",
    ),
    [date, setDate] = useState(initial.current?.date ?? localToday());
  const [health, setHealth] = useState<Health | null>(null),
    [healthError, setHealthError] = useState(false),
    [formError, setFormError] = useState(
      window.location.pathname !== "/" && !initial.current
        ? "This flight link is invalid. Enter a flight number and date below."
        : "",
    );
  const [saved, setSaved] = useState(() => readFlights("saved")),
    [recent, setRecent] = useState(() => readFlights("recent")),
    [storageError, setStorageError] = useState(""),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [now, setNow] = useState(Date.now());
  const { result, loading, error, refresh } = useFlight(query);
  const current =
    result?.flights.find((f) => f.id === selectedId) ?? result?.flights[0];
  useEffect(() => {
    if (result && revealFlight.current) {
      revealFlight.current = false;
      if (window.matchMedia?.("(max-width: 760px)").matches) {
        trackerPanel.current?.scrollIntoView?.({
          block: "start",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "instant"
            : "smooth",
        });
      }
    }
  }, [result?.query.flightNumber, result?.query.date]);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const deadline = setTimeout(() => controller.abort(), 15_000);
    void getHealth(controller.signal)
      .then((value) => {
        if (!disposed) setHealth(value);
      })
      .catch(() => {
        if (!disposed) setHealthError(true);
      })
      .finally(() => clearTimeout(deadline));
    return () => {
      disposed = true;
      clearTimeout(deadline);
      controller.abort();
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const pop = () => {
      const parsed = parseFlightPath(window.location.pathname);
      setQuery(parsed);
      setSelectedId(null);
      setFormError(
        window.location.pathname !== "/" && !parsed
          ? "This flight link is invalid."
          : "",
      );
      if (parsed) {
        setFlightNumber(parsed.flightNumber);
        setDate(parsed.date);
      }
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (result) {
      const next = remember(readFlights("recent"), result.query, 8);
      setRecent(next);
      if (!writeFlights("recent", next))
        setStorageError(
          "This browser couldn't save your history. Flight tracking still works.",
        );
    }
  }, [result?.query.flightNumber, result?.query.date]);
  useEffect(() => {
    document.title = current
      ? `${current.flight.ident} · ${STATUS[current.status]} · Roamio`
      : "Roamio · Know your flight";
  }, [current?.flight.ident, current?.status]);
  function open(q: FlightQuery) {
    revealFlight.current = true;
    setFlightNumber(q.flightNumber);
    setDate(q.date);
    setFormError("");
    setSelectedId(null);
    if (query && queryKey(q) === queryKey(query)) refresh();
    else setQuery(q);
    const path = flightPath(q);
    if (window.location.pathname !== path) history.pushState(null, "", path);
  }
  function search(event: FormEvent) {
    event.preventDefault();
    const parsed = QuerySchema.safeParse({ flightNumber, date });
    if (!parsed.success) {
      setFormError("Check the flight number and use a valid operating date.");
      return;
    }
    open(parsed.data);
  }
  function saveList(next: FlightQuery[]) {
    if (!writeFlights("saved", next))
      setStorageError(
        "This browser couldn't save your flights. They may disappear after a reload.",
      );
    setSaved(next);
  }
  function remove(q: FlightQuery) {
    saveList(saved.filter((v) => queryKey(v) !== queryKey(q)));
  }
  const tracked = Boolean(
    query && saved.some((q) => queryKey(q) === queryKey(query)),
  );
  function toggleSave() {
    if (!query) return;
    if (tracked) remove(query);
    else if (saved.length >= 20)
      setStorageError(
        "You can track up to 20 flights. Remove one to make room.",
      );
    else saveList(remember(saved, query, 20));
  }
  return (
    <div className="app-shell">
      <header className="site-header">
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            history.pushState(null, "", "/");
            setQuery(null);
            setFormError("");
          }}
        >
          <span className="brand-icon">
            <Icon name="plane" size={23} />
          </span>
          roamio<span className="brand-period">.</span>
        </a>
        <nav>
          <span className="nav-tracker">Flight tracker</span>
          <a href="#my-flights">
            My flights <span>{saved.length}</span>
          </a>
        </nav>
      </header>
      <main>
        <section className="search-section">
          <div className="intro">
            <div>
              <span className="eyebrow">LESS GUESSWORK. MORE JOURNEY.</span>
              <h1>Know your flight.</h1>
            </div>
            <p>
              From the first departure
              <br />
              to the final arrival. Stay in the know.
            </p>
          </div>
          {health?.mode === "demo" && (
            <div className="mode-banner" role="status">
              <span className="demo-tag">DEMO DATA</span>
              <span>
                Not live flight information. Explore a synthetic journey below.
              </span>
            </div>
          )}
          {health?.mode === "live" && !health.configured && (
            <div className="mode-banner unavailable" role="alert">
              <strong>UNAVAILABLE</strong>
              <span>
                Live mode needs a FlightAware API key on the server. See
                docs/TRACKER.md.
              </span>
            </div>
          )}
          {healthError && (
            <div className="mode-banner unavailable" role="alert">
              UNAVAILABLE · We couldn't connect to the flight service.
            </div>
          )}
          <form className="search-form" onSubmit={search}>
            <div className="flight-input">
              <Icon name="plane" size={23} />
              <label htmlFor="flight-number">
                Flight number
                <input
                  id="flight-number"
                  name="flightNumber"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={24}
                  placeholder={health?.mode === "demo" ? "RM 104" : "UA 123"}
                  value={flightNumber}
                  onChange={(e) => setFlightNumber(e.target.value)}
                  aria-describedby={formError ? "form-error" : undefined}
                />
              </label>
            </div>
            <label className="date-input" htmlFor="flight-date">
              Operating date
              <input
                id="flight-date"
                name="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <button className="search-button" type="submit">
              Find my flight
              <Icon name="arrow" />
            </button>
          </form>
          {formError && (
            <p className="form-error" id="form-error" role="alert">
              {formError}
            </p>
          )}
          {health?.mode === "live" && (
            <p className="search-hint">
              Origin-local departure date · recent flights and the next two days
              · ICAO flight numbers are preferred when a match is unclear.
            </p>
          )}
          {health?.mode === "demo" && (
            <div className="demo-options">
              <span>TRY A JOURNEY</span>
              {health.examples.map((e) => (
                <button
                  key={e.flightNumber}
                  className={
                    query?.flightNumber === e.flightNumber ? "selected" : ""
                  }
                  onClick={() => open({ flightNumber: e.flightNumber, date })}
                >
                  {e.label}
                  <small>{e.flightNumber}</small>
                </button>
              ))}
            </div>
          )}
          {recent.length > 0 && (
            <div className="recent">
              <span>Recent</span>
              {recent.slice(0, 5).map((q) => (
                <button key={queryKey(q)} onClick={() => open(q)}>
                  {q.flightNumber}
                  <small>{niceDate(q.date)}</small>
                </button>
              ))}
            </div>
          )}
        </section>
        {error && (
          <ErrorPanel
            title={
              error.code === "flight_not_found"
                ? `No flight found for ${query?.flightNumber}`
                : error.code === "rate_limited"
                  ? "A short pause between updates."
                  : "Flight updates are unavailable."
            }
            retry={refresh}
          >
            {error.message}
            {error.code === "flight_not_found" && query
              ? ` ${niceDate(query.date)} · Try another date${health?.mode === "demo" ? " or one of the demo journeys above" : " or the operating carrier's flight number"}.`
              : ""}
            {error.retryAfterSeconds
              ? ` Retry after ${error.retryAfterSeconds} seconds.`
              : ""}
            {current
              ? " The last available observation is shown below as stale."
              : ""}
          </ErrorPanel>
        )}
        {loading && !result && <Skeleton />}
        {result && current && (
          <section
            ref={trackerPanel}
            className="tracker"
            aria-label="Flight tracker"
          >
            <div className="result-heading">
              <span>
                {niceDate(result.query.date)} ·{" "}
                {current.dateBasis === "origin_local"
                  ? "Origin-local operating date"
                  : "UTC date · origin timezone unknown"}
              </span>
              {result.coverage === "limited" && (
                <span className="partial-note">
                  Limited provider coverage · more matches may exist
                </span>
              )}
            </div>
            {result.flights.length > 1 && (
              <label className="match-select">
                More than one flight matches. Choose a journey:
                <select
                  aria-label="Choose matching flight"
                  value={current.id}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {result.flights.map((f) => (
                    <option value={f.id} key={f.id}>
                      {f.flight.ident} · {f.origin.airportCode ?? "?"} →{" "}
                      {f.destination.airportCode ?? "?"} ·{" "}
                      {timeLabel(f.scheduled.departure, f.origin.timezone)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {isStale(current, now) && (
              <div className="stale-notice" role="status">
                STALE DATA · This observation is out of date. Confirm any travel
                changes with your airline.
              </div>
            )}
            {current.data.notices.includes("tracking_stopped") &&
              current.status !== "cancelled" && (
                <div className="stale-notice">
                  The provider has stopped tracking this flight. This does not
                  confirm cancellation.
                </div>
              )}
            <div className="tracker-grid">
              <FlightView
                flight={current}
                now={now}
                saved={tracked}
                onSave={toggleSave}
                loading={loading}
                refresh={refresh}
              />
            </div>
          </section>
        )}
        {!query && (
          <section className="welcome">
            <div className="welcome-symbol">
              <Icon name="plane" size={36} />
            </div>
            <div>
              <h2>A little clarity for your next flight.</h2>
              <p>
                Search a flight number to see the journey unfold.
                <br />
                Times, gates and the latest updates, all together.
              </p>
            </div>
          </section>
        )}
        {storageError && (
          <p className="storage-warning" role="status">
            {storageError}
          </p>
        )}
        <SavedFlights
          saved={saved}
          active={query}
          activeFlight={current}
          now={now}
          open={open}
          remove={remove}
        />
        {current && (
          <details className="developer">
            <summary>Developer details</summary>
            <p>
              Provider: {current.data.provider} · Mode: {current.data.mode} ·
              Source timestamp:{" "}
              {current.data.providerUpdatedAt ?? "not supplied"}
            </p>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </details>
        )}
      </main>
      <footer className="site-footer">
        <a className="footer-brand" href="/">
          roamio.
        </a>
        <span>
          {health?.mode === "demo"
            ? "A clearer journey. Demonstration data only."
            : health?.mode === "live"
              ? "Flight data by FlightAware. Always confirm changes with your airline."
              : "Connecting to flight updates."}
        </span>
        <span>Made for the journey.</span>
      </footer>
    </div>
  );
}
