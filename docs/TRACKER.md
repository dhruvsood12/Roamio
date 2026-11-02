# Roamio flight tracker

## Start

Use Node 24.13+ and the repository's npm lockfile:

```bash
npm install
npm run tracker
```

Open the printed localhost URL, normally `http://127.0.0.1:4173`. An occupied port
falls back to a free port. One process builds and serves the UI/API. Restart after
source edits; only compiled assets are served, with no dev-server filesystem
endpoints. Ctrl+C stops the server.

## What works

Flight-number/date search, status, gate/runway timeline, delay, airport-local
times, gates/terminals, aircraft, an offline latest-position map, labelled
time-based progress without coordinates, refresh, saved flights, recent searches
and `/flight/RM104/2026-11-01` deep links. Unknown facts stay unknown.

Default mode is **DEMO DATA — not live flight information**. RM101–RM111 cover
scheduled, delayed, boarding, in air, landed, cancelled, diverted, missing gate,
missing position, stale data and arrived. RM404 tests not-found; RM500 tests
provider failure; RM429 tests a 30-second rate limit. All facts are synthetic,
including positions/aircraft. Examples are deterministic for the injected clock,
session epoch and date. Refresh changes observation timestamps without invented
aircraft movement. Historical/future dates retain the selected illustrative status.

## Live FlightAware mode

FlightAware AeroAPI was selected for its documented flight lookup, operational
times, gates, aircraft and position endpoint. Use an authorized account/key with
the necessary endpoint access and quota. Set these server environment variables
or put them in a local, git-ignored `.env`, then restart:

```dotenv
TRACKER_PROVIDER=flightaware
FLIGHTAWARE_API_KEY=your-authorized-key
```

Never use `VITE_*` for the key. Live mode without a key reports UNAVAILABLE and
never silently substitutes fixtures. No authorized key was available during
implementation. **Live smoke testing and captured-response validation remain
pending.** Adapter fixtures are explicitly synthetic, based on
[official OpenAPI 4.17.1](https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml),
not captured flights. See `tests/tracker/fixtures/README.md`.

Date means origin-local scheduled gate departure (runway departure is a fallback
for date selection only). Unknown timezone uses labelled UTC; an unknown date is
not guessed. API date omission defaults to today's UTC date; the UI sends an
explicit date. Input calendar dates are bounded to 1900–2100. FlightAware documents
ten days back/two days forward for explicit
query bounds. Clamped windows, pagination or unresolved dates are labelled limited.
ICAO designators are preferred when IATA/codeshare lookup is unclear. Multiple
matches and diversion legs stay separate. A `cancelled` flag alone means tracking
stopped; it does not prove airline cancellation. Gate times never become runway
times. Status source-update time is unavailable, so fresh retrieval is RECENT,
not LIVE. Position freshness is separate and always timestamped.

## Architecture and safeguards

- `apps/tracker-shared`: strict status DTOs and deterministic time calculations.
- `apps/tracker-server`: one provider interface, live/demo adapters, cache and API.
- `apps/tracker-web`: React UI. Existing shopping/planning packages are unchanged.
- GET `/api/health`: mode/configured state. GET `/api/flights/:ident?date=YYYY-MM-DD`:
  normalized observations or typed 400/404/429/502/503 errors, without raw payloads.
- Loopback-only server, Host checks, CSP, no CORS/proxy, no browser credentials.
- 128 cached queries; identical pending requests coalesce; four concurrent lookups;
  12-second deadline. TTLs: active 30s, scheduled 120s, finished 300s, demo 10s.
- Temporary failures may return observations up to 15 minutes old, explicitly
  stale with original receipt time. Error cache 15s; provider 429 cooldown applies
  across queries. Direct-client limit 90 requests/minute, bounded to 1,024 addresses.
- Monotonic quota/cache clocks; local receipt clamps to request start on rollback.
  Provider timestamps remain provider facts. Old/future source times are unconfirmed.
- One provider page, at most 20 matches. Optional map enrichment is first-match
  only: at most two airport calls and one position call, each with a 2s deadline.
  Airport coordinates are requested only when a position is available and cache
  for 24h/128 entries. No arbitrary pagination URLs followed.
- Open-flight polling by state: in-motion (in_air/departed/boarding/diverted) 30s;
  pre-departure (scheduled/delayed and other ground states) 120s; finished
  (arrived/landed/cancelled) 300s; demo 15s. A delayed flight stays on the 120s
  pre-departure cadence until it boards/departs, then moves to 30s. Hidden
  tabs pause; navigation cancels; no overlap. Saved-list status fetches on display;
  continuous polling is for the open flight. Other cards visibly age.
- Browser storage: 20 saved/8 recent identifiers only; corruption and quota failure
  are handled. Local URLs require access to the same local server.

The map is offline, using public-domain
[Natural Earth land](https://www.naturalearthdata.com/about/terms-of-use/), converted
from its [1:110m GeoJSON](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson)
to `apps/tracker-web/public/world.svg`. Equirectangular projection; the dotted
direct-route guide is not a flown track. No external tiles/fonts/scripts are used.

## Verification and limits

```bash
npm run test:tracker
npm test
npm run typecheck
git diff --check
```

Tests cover DTOs, offset/DST/millisecond handling, clock rollback, provider mapping,
errors, secret exclusion, cache/coalescing/timeouts, rate limits, UI state,
save/reload, refresh races, hidden tabs, storage failure and partial/stale data.
Browser acceptance covers desktop, tablet and 390px mobile. Live smoke needs a key.

No accounts, notifications, database or hosting. Provider plan coverage, codeshare
lookup and position availability vary. Optional enrichment is bounded, not exhaustive.
Confirm travel changes with the airline. Existing Vitest 3 test-only dependencies
have npm audit findings; they are not served by the tracker. Vite/Zod received
compatible security updates. Core contracts and fingerprint goldens are unchanged.
