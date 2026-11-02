# Roamio — current engineering state

Updated: 2026-10-11. This is a compact handoff; read `AGENTS.md`, the current task
specification and relevant contracts/code before acting. Expand exploration only
when needed. This file does not authorize implementation or publication.

## Baseline and current work

- Published core baseline: `927d18f737c177d931d1ced5e10cf1f28c33af64` (C002.3c).
- C002.3a canonical discovery contracts: published.
- C002.3b-S schema-independent Rome2Rio scaffold: **published**, not pending.
- C002.3b-M native Rome2Rio mapping: **blocked** on authorized schemas/responses.
- Current demo branch: `feat/roamio-core-demo`; demo committed after independent review.
- C002.3c verification-job planning: **published; final review passed**.
  Provider execution and TripOption construction were explicitly split into a
  follow-up. Do not mark the whole composer milestone complete.

Published core verification on `main`: **1,378 tests passed / 0 failed**, including
138 planner tests; typecheck and diff check passed. Local and remote main matched.
Schedule Fingerprint V1 code and golden tests are unchanged.

Demo verification: **1,391 tests passed / 0 failed**, including 13 demo tests;
typecheck and diff check passed. Browser checks covered all presets, original evidence
bindings, unknown dates and multimodal rejection. Core packages remain unchanged.
The demo passed an independent two-model adversarial review (Opus + Haiku: CLEAN)
and is committed on `feat/roamio-core-demo`.

## Planning semantics and next action

Final review found no remaining blockers. Additional read-only probes passed:
200 budget/binding cases and 242 endpoint mutations. The local developer demo is
separate from the frozen core. It exercises existing functions with synthetic
fixtures; no execution/composition milestone is being implemented.

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
transfer policy, offer-bound protection evidence, automatic TripOption composition,
production trip ranking, real integrations, revalidation, cost controls and consumer UI.

## Working protocol

Use compact implementation reports: changed, behavior, verification, deferred,
status. Reserve detailed reports/logs for adversarial reviews and relevant failures.
Before adding an abstraction, check existing code, standard library and installed
dependencies. Never trade correctness or test coverage for shorter context.

After planner approval, publication and a state update, start the next milestone in
a fresh session using this file, `AGENTS.md`, its task specification and relevant
files. Do not carry resolved investigations or raw passing logs into that session.

## Demo status reference

The local page reads this table directly. Update this source when a milestone changes.
`IMPLEMENTED` below describes the named contract/function, not live provider access.

<!-- demo-status:start -->
| Capability | Status | Scope |
| --- | --- | --- |
| Route Discovery Contract | IMPLEMENTED | Canonical candidates, source facts and partial observations. |
| Rome2Rio scaffold | IMPLEMENTED | Schema-independent failure, privacy and rights boundaries. |
| Rome2Rio native mapping | BLOCKED | Await authorized genuine schemas and responses. |
| Route examples | SIMULATED WITH CANONICAL FIXTURES | Synthetic routes exercise the real contracts and planner. |
| Verification Planner | IMPLEMENTED | Exact intent grouping, evidence binding and bounded planning. |
| Provider execution | NOT YET BUILT | No live searches, fares, availability or booking. |
| FlightOffer, Fingerprint V1 and Money | IMPLEMENTED | Domain functions demonstrated using synthetic offers. |
| TripOption contract and explicit-plan builder | IMPLEMENTED | Validates selected components; examples are synthetic. |
| Automatic TripOption composition | NOT YET BUILT | No automatic verification-job-to-offer-to-trip pipeline. |
| TripOption ranking | NOT YET BUILT | Production ranking of complete trips remains later work. |
| Consumer UI | NOT YET BUILT | This local developer demo is not a consumer booking product. |
<!-- demo-status:end -->
