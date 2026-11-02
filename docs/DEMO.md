# Roamio Core Intelligence Demo

Start with `npm run demo` and open **http://127.0.0.1:4173**. Stop with Ctrl+C.
Dependencies must already be installed (`npm install` for initial repository setup).
Runtime needs no external network, credentials or provider services. To avoid an
occupied port, use `ROAMIO_DEMO_PORT=4174 npm run demo`.

The demo binds only to loopback. Vite, already used by the test toolchain and now
declared directly, loads repository TypeScript on Node. Pages are plain server-rendered
HTML/CSS. Budget/scenario forms rerun the real planner on local page requests; native
details panels expose evidence. There is no browser framework, client script,
database, production server or outbound data call. Only `/` and `/styles.css` are served.
HMR and its WebSocket listener are disabled; restart the command after source edits.

## What to inspect

- **Planner:** the shared four-route regression fixture drives the candidate cards.
  Real `planVerificationJobs` output supplies the 13 spans / 12 intents under generous
  budgets, grouped source bindings, selected jobs and canonical diagnostics.
- **Budgets:** candidate and leg admission happens before the displayed grouping
  counts. The omitted-intent count compares two real plans with identical candidate/
  leg limits and different job limits. Unexamined candidates are shown separately.
  The two-route eight-slot regression also runs the real planner.
- **Unknown dates:** unspecified request dates and arrival dependencies stay visible.
  These intents cannot yet be submitted as normal provider requests.
- **Multimodal:** the existing Stockholm–Copenhagen–Tokyo rail/flight fixture remains
  intact. Its city request returns `unsupported_request_location`; no flight portion
  is extracted. The boundary-case scenario separately shows `unsupported_movement`,
  `stale_candidate` and `invalid_candidate` from the real planner.
- **Core contracts:** actual V1 fingerprint/grouping functions preserve separate
  offers, ignore price/marketing differences for schedule identity and retain a null
  fingerprint when operating identity is missing. Exact Money helpers add like
  currencies and reject mixed addition; payment summaries retain separate units.
- **TripOption:** `createTripOption` and `TripOptionSchema` validate an explicitly
  selected synthetic cash/award/cash plan. The builder derives booking boundaries,
  self-transfer warnings and payment totals. It is not an automatic composer.
- **Engineering state:** the status pipeline is read directly from the marked table
  in `CURRENT_STATE.md`; the raw source is also inspectable. Missing/invalid status
  data fails rendering rather than substituting a second roadmap.

All commercial examples are **SYNTHETIC VERIFIED COMMERCIAL FIXTURES**. “Verified” is
a fixture role, not a claim of live verification. No planner job is connected to a
fake provider response. No price, schedule, award availability or capability is live.
Discovery examples contain unknown estimates; the page does not supply missing ones.

## Development boundary

The demo imports existing packages and shared test fixtures. No package imports demo
code. The four-route test fixture was extracted without changing its values or
regression assertions. Core domain, planner and fingerprint implementations remain
unchanged from published commit `927d18f`.

`npm test`, `npm run typecheck` and `git diff --check` validate the change. Focused demo
tests check rendering against actual output, budget reruns, provenance visibility,
unknown dates, safe escaping, offline execution and the current-state source.
