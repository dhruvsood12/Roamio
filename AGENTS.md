# Codex Operating Contract

## Mission
Build FlightBrain incrementally without weakening data provenance, type safety, provider isolation, or test coverage.

## Hard rules
1. Never invent flight prices, schedules, fare rules, award availability, or provider capabilities.
2. Never bypass CAPTCHAs, anti-bot systems, authentication, access controls, robots restrictions, or provider terms.
3. Every provider integration must implement `FlightProvider` and map into the canonical domain model.
4. Provider-specific fields must not leak into UI/business logic except through `providerMetadata`.
5. Every returned offer requires provenance: provider, retrievedAt, expiresAt if known, and booking/revalidation strategy.
6. Revalidate an offer before purchase/redirect whenever provider semantics allow it.
7. Do not create a single opaque "AI score". Ranking must expose component metrics.
8. LLM output is advisory/explanatory only. Deterministic code owns search, pricing, dedupe, and ranking.
9. Split-ticket itineraries must be labeled prominently and never presented as equivalent to protected connections.
10. Add or update tests with every domain/provider/ranking change.

## Change discipline
- Prefer one concern per change.
- Do not rewrite architecture to solve a local task.
- If a provider cannot map reliably to the canonical schema, surface `unknown`/nullable data rather than guessing.
- Keep source adapters stateless where possible.
- Treat provider quotas, latency, partial failures, and stale data as normal operating conditions.

## Definition of done
- Types pass.
- Tests pass.
- Failure cases covered.
- No secrets committed.
- Provenance preserved.
- User-facing claims trace to deterministic data.
