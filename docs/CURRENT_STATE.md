# Roamio — current engineering state

Read `AGENTS.md`, this file and relevant task files. This handoff does not authorize
publication or another milestone.

## Published core

`main` / `origin/main`: `927d18f737c177d931d1ced5e10cf1f28c33af64` when the tracker
branch was created. Exact Money, Schedule Fingerprint V1, FlightOffer/TripOption,
discovery contracts and bounded verification-job planning are published. Standard
planner routes retain 13 source spans / 12 unique intents.

As of 2026-11-02 the C002.3c execution/composition pipeline is published as pure,
import-isolated composer contracts (each a single module under `packages/composer/src`,
schema-parsed at the boundary, deterministic, injected `asOf`, no wall clock): E0
execution-admissibility gate (`execution.ts`), E1 commercial request resolution
(`resolution.ts`), E2 connection feasibility (`feasibility.ts`), E3 cumulative
execution ledger (`ledger.ts`), E4 deterministic offline mock-provider intake
(`intake.ts`), E5 connection protection facts (`protection.ts`). These are contracts
and functions, NOT live provider access. Live provider execution and automatic
TripOption composition (E6) remain unimplemented.

Rome2Rio scaffold is published. Native mapping remains blocked on authorized
schemas/responses. Do not invent fields or bypass access controls. Discovery and
planning remain source-agnostic and independent of that block.

## Current work: local flight tracker

`feat/live-flight-tracker`, reviewed and committed (open as PR #1). Launch
`npm run tracker`. See `TRACKER.md` for configuration, limits and verification commands.

- Consumer UI: search/status, route/position, timeline, gates, aircraft, delay,
  refresh, save/untrack, recent searches, deep links and responsive layouts.
- Tracker-specific strict DTOs separate operational status from FlightOffer.
- Local server: normalized API, bounded cache/coalescing, stale fallback,
  rate limits, cancellation/timeouts and server-only provider credentials.
- FlightAware AeroAPI adapter follows official OpenAPI 4.17.1. No authorized key
  is available; live smoke and genuine captured-response validation remain pending.
  Adapter tests use explicitly synthetic official-schema responses.
- Default DEMO mode works through the same API/UI, with eleven synthetic scenarios.
  Browser storage holds identifiers only. No live claims for fixtures.

Verification: 1,568 full-suite tests / 190 tracker tests pass; typecheck and diff
checks pass. Desktop, tablet and 390px mobile browser acceptance pass with no
console errors. Schedule Fingerprint V1's 54 tests and golden behavior are unchanged.

Adversarial multi-model review (Opus + Haiku) of the tracker diff found and fixed
one correctness defect — the saved-flights list shared one AbortController across a
sequential loop, so a single stalled lookup aborted the shared signal and poisoned
every remaining saved flight to UNAVAILABLE; each lookup now owns its controller,
locked by a regression test. A defensive guard also prevents the stale-fallback
`refresh_failed` notice from exceeding the 5-notice contract under duplicate notices.

The reviewed core demo is committed on `feat/roamio-core-demo` (open as PR #2).
Published main had 1,378 tests; the demo branch has 1,391. Tracker tests are
additive, for 1,568 on this branch.

## Frozen boundaries and deferred work

Schedule Fingerprint V1 is frozen; unknown operating identity never establishes
equality. Exact Money uses minor-unit integer strings. Discovery facts never imply
commercial price, availability, protection or booking relationships. Unknown facts
stay unknown and evidence stays attributable to its source.

Commercial request/date resolution, execution admissibility + replay/budget gating,
connection feasibility/transfer policy, and offer-bound protection evidence now exist
as the C002.3c composer contracts above (pure, offline, synthetic-input). Still
deferred: live provider execution, automatic TripOption composition (E6), ranking of
complete trips, shopping integrations and revalidation. This tracker does not implement
or authorize these. No accounts, database, notifications, cloud deployment, payments,
booking, awards, FX or AI chat.

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
| Execution admissibility gate (E0) | IMPLEMENTED | Pure gate: fixed-precedence rejection, per-leg staleness, budget. |
| Commercial request resolution (E1) | IMPLEMENTED | Admissible jobs → bound commercial request descriptors. |
| Connection feasibility (E2) | IMPLEMENTED | feasible/infeasible/unknown per connection; split-ticket, never "protected". |
| Execution ledger (E3) | IMPLEMENTED | Cumulative, content-keyed replay accounting; no double-count. |
| Mock-provider intake (E4) | SIMULATED WITH CANONICAL FIXTURES | Deterministic offline synthetic offers; no network, clearly synthetic. |
| Connection protection facts (E5) | IMPLEMENTED | Honest protected/self_transfer/unknown; fingerprint carried, not recomputed. |
| Provider execution | NOT YET BUILT | No live searches, fares, availability or booking. |
| FlightOffer, Fingerprint V1 and Money | IMPLEMENTED | Domain functions demonstrated using synthetic offers. |
| TripOption contract and explicit-plan builder | IMPLEMENTED | Validates selected components; examples are synthetic. |
| Automatic TripOption composition | NOT YET BUILT | No automatic verification-job-to-offer-to-trip pipeline. |
| TripOption ranking | NOT YET BUILT | Production ranking of complete trips remains later work. |
| Consumer UI | NOT YET BUILT | This local developer demo is not a consumer booking product. |
<!-- demo-status:end -->
