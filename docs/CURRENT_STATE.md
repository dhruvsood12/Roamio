# Roamio — current engineering state

Updated: 2026-10-09. This is a compact handoff; read `AGENTS.md`, the current task
specification and relevant contracts/code before acting. Expand exploration only
when needed. This file does not authorize implementation or publication.

## Baseline and current work

- Previous published baseline: `f520b8ca673befb3f139fb42263b15ff7de0c419`.
- C002.3a canonical discovery contracts: published.
- C002.3b-S schema-independent Rome2Rio scaffold: **published**, not pending.
- C002.3b-M native Rome2Rio mapping: **blocked** on authorized schemas/responses.
- Current branch: `codex/bounded-verification-planner`.
- C002.3c verification-job planning: **final review passed; publication approved**.
  Provider execution and TripOption construction were explicitly split into a
  follow-up. Do not mark the whole composer milestone complete.

Latest verification: **1,378 tests passed / 0 failed**, including 138 planner tests;
typecheck and diff check passed. Schedule Fingerprint V1 code and golden tests are
unchanged.

## Planning semantics and next action

Final review found no remaining blockers. Additional read-only probes passed:
200 budget/binding cases and 242 endpoint mutations. Publish this reviewed core,
verify the full suite on `main`, then build the local developer demo separately on
`feat/roamio-core-demo`. Demo changes must remain uncommitted for review.

- Occurrence spans preserve provenance in `sourceBindings[]`; the result boundary
  checks actual source endpoints, order, adjacency, span and original evidence refs.
  General discovery candidates may still contain discontinuous hints.
- The provider-job budget counts unique canonical executable intents, not bindings.
  Exact-equivalent intents carry all source bindings. Full paths, departure state
  and existing passenger context determine equivalence within one request/plan.
- Arrival dependencies include candidate occurrence and preceding-leg index, so
  unrelated unknown arrivals cannot group. A shared unspecified request departure
  remains one request-level intent.
- First intent encounter determines job order. Enumeration continues after the
  budget fills to retain late bindings to selected intents; omitted unique intents
  produce `job_limit`. Candidate/leg limits bound span enumeration.
- Structural plan validation is distinct from future execution eligibility. Before
  calls, a trusted execution gate must check the active request, current freshness
  and policy, coverage, replay and cumulative cost. It is not implemented here.

The four standard routes produce **13 occurrence spans / 12 unique intents**.
DEL–NRT shares one intent with two bindings. These are not directly executable
FlightProvider requests or a guarantee of 12 API calls.
See `VERIFICATION_PLANNER.md`, `../packages/composer/src/contracts.ts`,
`../packages/composer/src/index.ts` and `../tests/verification-planner.test.ts`.

## Architecture and frozen invariants

- Discovery sources produce canonical `RouteCandidate`s: investigation leads,
  never commercial offers. The planner depends on canonical contracts only, with
  no Rome2Rio-specific imports.
- Planning is pure and bounded by candidate, leg and job limits. It preserves
  occurrence indexes and original evidence bindings. Unsupported paths receive
  explicit decisions. Unresolved dates remain unresolved.
- Commercial providers supply `FlightOffer` observations. Future composition
  builds complete `TripOption`s while preserving booking/payment boundaries,
  provenance, protection state, chronology and exact money.
- Schedule Fingerprint V1 is frozen. Missing operating identity yields no definitive
  fingerprint; no marketing fallback or equality inferred from unknown identity.
- Money uses `amountMinor` as a canonical integer string, supported currency and
  its metadata exponent. No floating-point money arithmetic or FX.
- Discovery estimates/schedules never establish commercial price, availability,
  booking relationships or connection protection. Unknown facts stay unknown.
- Evidence remains attributable to source, candidate occurrence and original fact
  target. No silent rebinding. All booked flight segments are intended to be flown.

## Rome2Rio and deferred work

The injectable scaffold is experimental and discovery-only. Production rights are
unverified. Authorized MCP initialization returned Cloudflare 403; no genuine
authorized tool schemas or sanitized response fixtures are available. Do not guess
native payload fields, scrape or bypass access controls. Native mapping remains an
integration limitation, not a dependency for canonical planning.

Deferred: commercial request/date resolution, provider execution, feasibility and
transfer policy, offer-bound protection evidence, TripOption construction, ranking,
real authorized integrations, revalidation, observability/cost controls and UI.

## Working protocol

Use compact implementation reports: changed, behavior, verification, deferred,
status. Reserve detailed reports/logs for adversarial reviews and relevant failures.
Before adding an abstraction, check existing code, standard library and installed
dependencies. Never trade correctness or test coverage for shorter context.

After planner approval, publication and a state update, start the next milestone in
a fresh session using this file, `AGENTS.md`, its task specification and relevant
files. Do not carry resolved investigations or raw passing logs into that session.
