# Codex Task Queue

Run these in order except C002.3c, which may proceed independently of C002.3b-M.
Each task should be a separate Codex change.

## C001 — Domain contracts
Implement/verify canonical `SearchRequest`, `FlightOffer`, `Itinerary`, `ProviderObservation`, money, duration and warning schemas. Add exhaustive unit tests.

## C002 — Fingerprinting and dedupe
Complete: Schedule Fingerprint V1 hashes ordered journeys and operating segments
with UTC millisecond instants. Group exact known schedules while preserving every
commercial offer; incomplete operating identity stays in separate singleton groups.
See [DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#schedule-fingerprint-v1) for the fixed V1 contract.

## C002.1 — Exact Money
Implement exact JSON-safe minor-unit money, versioned currency exponents, integer
arithmetic and tax comparisons. Migrate fixtures and boundary documentation while
preserving Schedule Fingerprint V1. This is a prerequisite for composition and ranking.

## C002.2 — Trip composition contracts
Implemented for review: strict TripOption, BookingComponent, Connection and payment
contracts with exact native-unit summaries and complete source-segment coverage.
Pure helpers derive structural facts and warnings from explicit plans. No route
search, provider integration or ranking integration in this task.

## C002.3 — Bounded route graph / Trip Composer
Parent task split into bounded stages:

- **C002.3a — Route Discovery Source Contract:** implemented for review. Separate
  RouteDiscoverySource, multimodal location/request/candidate schemas, targeted
  evidence, estimate isolation, source capability/rights definitions and results that
  preserve accepted candidates on partial/timeout/error completion. Pure validation
  only; no adapter, network calls, dedupe, graph search or Trip Composer.
- **C002.3b-S — Rome2Rio schema-independent scaffold: IMPLEMENTED.** Experimental
  source metadata and a technical review record accompany an injected-client failure
  scaffold, default-denied source calls, request isolation, cancellation/deadline
  handling and completion timestamp clamping. No native mapper or live transport.
- **C002.3b-M — Rome2Rio native mapping: BLOCKED** on authorized genuine tool
  schemas/responses. MCP initialization returned Cloudflare 403; probing stopped.
  Resume mapping only with legitimate schema/fixture evidence; do not invent
  payloads or infer permissions from connector availability. Privacy, public IDs,
  rights attribution and evidence binding remain in native mapping.
  See [ROME2RIO_ADAPTER.md](ROME2RIO_ADAPTER.md).
- **C002.3c — Bounded Trip Composer:** split by user direction. **Verification-job
  planning is implemented for review** using canonical RouteCandidate fixtures and
  explicit candidate/leg budgets and a job budget over unique canonical intents.
  Exact-equivalent intents retain every source-span/evidence binding; unresolved
  occurrence dependencies prevent unsafe grouping. It depends on C002.3a, independently of blocked
  C002.3b-M native mapping. See [VERIFICATION_PLANNER.md](VERIFICATION_PLANNER.md).
  **Execution/composition remains a separate follow-up:** obtain commercial
  observations and construct feasible complete TripOptions under explicit execution
  budgets. Preserve native currencies and source evidence. Real-provider access must
  not block synthetic tests. C002.3c as a whole is not complete.

Future source-registry research can evaluate other MCP/API/open-data/GTFS sources.
C002.3a defines registry metadata only; it populates no production registry and grants
no source permissions. The planner defines finite-snapshot semantics, discovery
eligibility and observation-age policy. Before execution/composition, define
progressive batch/replay semantics, a trusted plan-for-execution validation gate,
commercial request eligibility, freshness and
transfer feasibility. Protection evidence binding, authoritative award provenance
and composer-side fingerprint verification remain in that follow-up as recorded
in the C002.2 review.

## C003 — Ranking complete TripOptions
Reserved: rank complete TripOptions with deterministic component metrics, Pareto
pruning and preference weights across price, duration, cabin, tickets and transfer
risk. Generate explanation reasons from metrics, not LLM prose.

## C004 — Provider orchestration
Implement deadlines, `Promise.allSettled`, provider result metadata, partial-success semantics and per-provider latency/error telemetry.

## C005 — Mock provider + fixture corpus
Create deterministic fixtures covering direct, connections, codeshares, airport changes, self-transfer, mixed cabin, stale offers and duplicates.

## C006 — First authorized real provider
Implement one provider adapter. Keep credentials server-side. Add contract tests using sanitized fixtures; no live API calls in unit tests.

## C007 — Search API
Wire request validation → orchestrator → grouping → ranking → response contract.

## C008 — Web results prototype
Build clean search/results UI using mock API. Show progressive loading and coverage state.

## C009 — Revalidation
Add provider capability flag and revalidation flow. Block stale redirect where revalidation fails.

## C010 — Observability/cost controls
Per-provider timeout, quota/cost counters, circuit breaker hooks and structured logs.
