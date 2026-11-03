# GOAL — finished, working product for a frequent traveler

**Persona:** someone who flies roughly every two weeks and wants the app to *automatically*
find the best way to fly a route they care about and keep it current — best cash price, the
most optimized way to spend miles/points, the best connections, and the fare perks that
matter (upgrade eligibility, free amenities, included bags/seats). They pick the route(s)
they're watching; the app re-evaluates on its own as prices/availability change and tells
them when something better appears. Above all they must never be misled: every number,
award cost, perk and connection is sourced from a real provider with provenance and
freshness — nothing invented, unknown stays unknown.

**Product shape:** a *flight-change / best-option tracker*. You tell it what you're looking
for; it continuously surfaces the best-ranked real options (cash, award/miles, connections,
perks) and watches them for you, the way the single-flight tracker already watches one
flight's status.

This file is the **definition of done** the autonomous loop drives toward. "Done" is
never "the agents agree" — it is **every gate below green** (`bash harness/gates.sh`
exit 0) with each capability demonstrated by deterministic tests. Anything requiring
an authorized external credential or a live network call is a **human-gated boundary**
the loop must stop at, not fake.

## NEAR-TERM FINISH LINE (set 2026-11-03): a USABLE version of Roamio
The immediate goal is not more contracts — it is a thing a person can **actually run and
use** locally, end to end, the way `npm run tracker` already runs the flight tracker. The
engine (discovery → execution → compose → rank → search API → results view → revalidation
→ miles ranking → watched-search) is built and green; what's missing for "usable" is the
**runnable wiring**:
- A **search input** (origins/destinations/date/pax/cabin/currency) a user fills in.
- Wire the **results-web app to `handleSearch`** (offline mock provider by default — honest,
  no credential) and render the ranked `SearchResponse` (cash-best + award-best + connections
  + freshness + honest self-transfer/unknown labels) via the C008 view that already exists.
- A **run script** (e.g. `npm run roamio`) that builds + serves the app on localhost, mirroring
  the tracker's build-then-serve (`apps/tracker-*` + its start script) — no dev-server file
  endpoints, server-only any future credentials.
- Optional: a **watched-search** affordance (register a route, re-evaluate, show "something
  better appeared") using `evaluateWatch` — but a minimal usable v1 can ship search→results
  first and add the watch view next.
"Usable" = a person opens localhost, types a route, and sees trustworthy ranked options
(clearly labelled DEMO/synthetic until a real provider key is supplied — exactly like the
tracker's DEMO mode). Real prices/availability/award/perk data remain the single human-gated
boundary (a real provider key); everything else is runnable now over the mock.

## Traveler-facing acceptance (what the product must do)

1. **Track a specific flight** — status, delays, gates/terminals, aircraft, local times,
   offline latest-position, saved flights, deep links. *Status: shipped (tracker).*
   Live AeroAPI mode exists but live smoke test is a human-gated boundary (needs an
   authorized key).
2. **Discover bounded routes** between two airports with provenance, freshness and
   confidence on every candidate — never an LLM/scraper/single provider as source of
   truth. *Status: contracts shipped (C002.3a).*
3. **Plan verification safely** — group only truly-equivalent route intents; honor
   departure/occurrence dependencies so no unsafe grouping. *Status: shipped (planner).*
4. **Execute a plan admissibly** — a pure gate decides which jobs may run, under a
   cumulative budget that replays cannot game. *Status: E0 ✅, E3 ledger in progress.*
5. **Resolve commercial requests** from admissible jobs with bound departure/passengers.
   *Status: E1 ✅.*
6. **Judge connection feasibility** for multi-leg trips: feasible/infeasible/unknown,
   honest about missing data, split-ticket labeled, "protected" never claimed.
   *Status: E2 ✅.*
7. **Intake offers from a provider** (first a deterministic mock, later an authorized
   real one) carrying clearly-sourced provenance. *Status: E4 ✅ (composer intake); C005
   real-interface mock provider in progress; C006 real provider human-gated.*
8. **Compose complete TripOptions** end-to-end from verified jobs → offers → trips.
   *Status: E6 ✅.*
9. **Rank complete trips** so the traveler sees the best real options first.
   *Status: C003 ✅ (honest metrics/reasons; no invented confidence; mixed-currency
   incomparable).*
10. **Search API + results view** a traveler can actually drive. *Status: C007 ✅ (API);
    C008 results view planned.*
11. **Revalidate** saved/upcoming trips as dates approach (freshness honored, stale
    labeled). *Status: C009 queued.*

### Vision capabilities (the "best-option tracker" — refined 2026-11-03)
These extend the pipeline above. Each is honest-only: computed from REAL provider-supplied
attributes with provenance; where the data needs a real provider/authorized award API, the
contracts + ranking + watch mechanism are built deterministically over synthetic data now
and the real data plugs in at the human-gated provider boundary (C006) — never fabricated.
12. **Best cash price** across providers for a watched route — already the core of C003
    ranking (`lowest_cash_price`, honest per-currency; mixed-currency incomparable). ✅ core.
13. **Optimized miles/points spend** — rank award/`cash_and_points` options by a real
    program's points cost + any cash component, surfacing the best redemption WITHOUT
    inventing a cash-equivalent for points. *Status: domain has `pointsByProgram`/
    `cash_and_points`; a points-aware ranking dimension + award-availability offer data are
    NOT YET BUILT (new slice; real award availability is human-gated).* 
14. **Perks / upgrades / free amenities** — model fare perks (upgrade eligibility, included
    bags/seats, lounge, amenities) as provider-sourced offer attributes and expose them as
    honest ranking signals/labels (never claim a perk the offer doesn't carry).
    *Status: NOT YET BUILT (new offer-attribute + ranking slice; real perk data human-gated).*
15. **Auto-updating watched searches** — the user registers the route(s)/criteria they're
    watching; the app re-runs the search deterministically on a schedule/trigger, diffs
    against the last ranked result, and surfaces "something better appeared" — the
    search-level analogue of the single-flight tracker's watch. *Status: NOT YET BUILT;
    builds on C009 revalidation + a watch/diff/notify slice; the orchestration core is
    already pure/deterministic/offline, so the re-run + diff is buildable now, with real
    data arriving via C006.*

## Deterministic gates (the arbiter)
- `bash harness/gates.sh` exits 0: full `npm run test` + typecheck + `git diff --check`.
- Every new composer module is in the import-isolation allowlist and imports only
  `@flightbrain/domain` + its declared siblings + `zod` (no fetch/scraper).
- No `Date.now`/`Math.random` in pure contract code; `asOf` is injected.
- `AGENTS.md` definition-of-done satisfied on every change.

## Build order the loop follows
Done & merged: **E0–E6** (execution gate → resolution → feasibility → ledger → mock intake
→ protection → composition), **C003 ranking**, **C004 orchestration**, **C005 mock provider
corpus**, **C007 search API**, **C008 results view**, **C009 revalidation**.
In council now: **item 13 points/miles ranking**, **item 15 watched-search** (`@flightbrain/watch`).
**NEXT — the usable-Roamio slice (TOP PRIORITY, per the near-term finish line above):** a
runnable app — search-input form + wire results-web to `handleSearch` (offline mock default)
+ a `npm run roamio` build-and-serve script mirroring the tracker — so a person can open
localhost, type a route, and see honest ranked DEMO results. Then the watched-search view
(`evaluateWatch`). THEN the remaining polish: **item 14 perks/upgrades/amenities**,
**C010 observability/cost**.
Skip **C002.3b-M** (BLOCKED on authorized Rome2Rio schemas) and **C006** (needs an
authorized real provider key). One bounded concern per slice; plan → implement →
council → gate → commit → PR → merge.

## Human-gated boundaries (loop STOPS, does not fake)
- Any live/real provider call or authorized API key (AeroAPI live smoke, Rome2Rio
  native mapping, first real provider C006).
- `~/.codex/config.toml` model change (user's global/desktop config).
- Anything irreversible or outward-facing beyond the repo's own GitHub PRs/merges,
  which the user has authorized for this session.

## When the loop reports "product done"
All non-human-gated acceptance items — 1–11 plus the vision capabilities 12–15 built as
honest contracts + ranking + watch mechanism over synthetic/mock data — demonstrated by
green tests, with the human-gated boundaries clearly listed as the only remaining work
requiring a credential. Items 13/14 (real award availability, real perk data) and item 15's
live data arrive only via a real provider (C006) and so remain partially human-gated: the
loop builds everything that does NOT need a credential and then presents the boundary list
and stops. "Best option" is only ever as true as the real data behind it — the loop never
closes that gap by inventing.
