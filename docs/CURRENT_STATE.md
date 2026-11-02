# Roamio — current engineering state

Read `AGENTS.md`, this file and relevant task files. This handoff does not authorize
publication or another milestone.

## Published core

`main` / `origin/main`: `927d18f737c177d931d1ced5e10cf1f28c33af64` when the tracker
branch was created. Exact Money, Schedule Fingerprint V1, FlightOffer/TripOption,
discovery contracts and bounded verification-job planning are published. Standard
planner routes retain 13 source spans / 12 unique intents. Provider execution and
automatic TripOption composition remain unimplemented.

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

Deferred: commercial request/date resolution and execution gates, provider execution,
feasibility/transfer policy, offer-bound protection evidence, TripOption composition,
ranking, shopping integrations and revalidation. This tracker does not implement
or authorize these. No accounts, database, notifications, cloud deployment, payments,
booking, awards, FX or AI chat.
