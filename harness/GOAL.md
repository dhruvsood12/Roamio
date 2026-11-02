# GOAL — finished, working product for a frequent traveler

**Persona:** someone who flies roughly every two weeks and needs to plan, book-research,
and track trips quickly without being misled. They care about: trustworthy options
(real provenance, no invented fares/schedules), multi-leg trips whose connections
actually make sense, and reliable day-of tracking.

This file is the **definition of done** the autonomous loop drives toward. "Done" is
never "the agents agree" — it is **every gate below green** (`bash harness/gates.sh`
exit 0) with each capability demonstrated by deterministic tests. Anything requiring
an authorized external credential or a live network call is a **human-gated boundary**
the loop must stop at, not fake.

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
   real one) carrying clearly-sourced provenance. *Status: E4 planned; C005/C006 queued.*
8. **Compose complete TripOptions** end-to-end from verified jobs → offers → trips.
   *Status: E6 + C002.2 composition; NOT YET BUILT.*
9. **Rank complete trips** so the traveler sees the best real options first.
   *Status: C003; NOT YET BUILT.*
10. **Search API + results view** a traveler can actually drive. *Status: C007/C008.*
11. **Revalidate** saved/upcoming trips as dates approach (freshness honored, stale
    labeled). *Status: C009.*

## Deterministic gates (the arbiter)
- `bash harness/gates.sh` exits 0: full `npm run test` + typecheck + `git diff --check`.
- Every new composer module is in the import-isolation allowlist and imports only
  `@flightbrain/domain` + its declared siblings + `zod` (no fetch/scraper).
- No `Date.now`/`Math.random` in pure contract code; `asOf` is injected.
- `AGENTS.md` definition-of-done satisfied on every change.

## Build order the loop follows
C002.3c remaining: **E3 (ledger) → E4 (mock-provider intake) → E5 (protection/fingerprint)
→ E6 (TripOption composition)**, then **C003 ranking → C004 orchestration → C005 mock
corpus → C007 search API → C008 results prototype → C009 revalidation → C010 observability**.
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
All non-human-gated acceptance items (1–5, 6, 7-mock, 8, 9, 10, 11) demonstrated by
green tests, with the human-gated boundaries clearly listed as the only remaining work
requiring a credential. At that point the loop presents the boundary list and stops.
