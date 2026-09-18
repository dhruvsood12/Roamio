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
Reserved: define complete TripOption, component/ticket boundaries and transfer
semantics, including future-compatible payment contracts. No route search in this task.

## C002.3 — Bounded route graph / Trip Composer
Reserved: compose feasible multi-ticket TripOptions using synthetic fixtures,
explicit search budgets, feasibility constraints and conservative Pareto pruning.

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
