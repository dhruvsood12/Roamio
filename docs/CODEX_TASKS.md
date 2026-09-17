# Codex Task Queue

Run these in order. Each task should be a separate Codex change.

## C001 — Domain contracts
Implement/verify canonical `SearchRequest`, `FlightOffer`, `Itinerary`, `ProviderObservation`, money, duration and warning schemas. Add exhaustive unit tests.

## C002 — Fingerprinting and dedupe
Complete: Schedule Fingerprint V1 hashes ordered journeys and operating segments
with UTC millisecond instants. Group exact known schedules while preserving every
commercial offer; incomplete operating identity stays in separate singleton groups.
See [DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#schedule-fingerprint-v1) for the fixed V1 contract.

Next, before C003: implement the exact-money contract patch from the architecture
review in a separate change. This is a prerequisite for ranking comparisons, not
part of C002. Do not carry floating-point major units or unconverted currency
comparisons into production ranking.

## C003 — Ranking baseline
Implement deterministic component metrics, Pareto pruning and default preference ranking. Return explanation reasons generated from metrics, not LLM prose.

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
