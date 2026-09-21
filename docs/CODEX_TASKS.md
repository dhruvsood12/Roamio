# Codex Task Queue

Run these in order. Each task should be a separate Codex change.

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
Reserved parent task; run these bounded stages next, not as part of C002.2:

- **C002.3a — Route Discovery Source Contract:** distinguish route hints, estimates,
  schedules and commercial quotes; define provenance and source capability/rights
  metadata without replacing the authoritative FlightProvider boundary.
- **C002.3b — Rome2Rio MCP experimental adapter:** candidate only. Verify current
  capabilities and permitted experimental access first. Discovery-only, never an
  authoritative price source; production authorization remains unverified. Do not
  infer backend, storage or redistribution rights from consumer app availability.
- **C002.3c — Bounded Trip Composer:** consume synthetic or authorized candidate
  routes, obtain commercial observations, and construct feasible complete TripOptions
  under explicit search budgets and conservative pruning. Preserve native currencies
  and source evidence. Real-provider access must not block synthetic composer tests.

Future source-registry research can evaluate other MCP/API/open-data/GTFS sources;
no registry or connector is implemented by C002.2.

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
