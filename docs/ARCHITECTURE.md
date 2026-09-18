# Architecture

## Services/modules

### Search API
Validates user intent and creates a normalized `SearchRequest`.

### Query Planner
Expands flexible dates/nearby airports under a strict request-cost budget.

### Provider Orchestrator
Fans out to approved providers concurrently. Each call has a deadline and isolation boundary. Partial failure does not fail the whole search.

### Provider Adapters
Map provider-native data to `FlightOffer` observations.

### Normalizer
Validates canonical schema, units, currency metadata, timestamps, cabin/fare semantics.
Canonical Money is an exact minor-unit string plus currency and validated exponent.
Currency metadata is a frozen versioned subset, used offline. Source decimal text
is converted with integer arithmetic; unsupported precision fails without rounding.
See [DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#exact-money--c0021).

### Itinerary Fingerprinter
Generates Schedule Fingerprint V1 from ordered journeys and operating segments,
including both scheduled instants normalized to UTC milliseconds. Canonical carrier
codes and flight numbers retain their exact spelling. Incomplete operating identity
returns null. The versioned serialization is specified in [DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#schedule-fingerprint-v1).

### Offer Grouper
Pure grouping preserves every source/commercial offer beneath an exact known
schedule. Each null fingerprint remains a separate singleton; null never implies
equality. Membership is independent of provider order, while output arrays retain
encounter order. Grouping does not select a fare, rank offers or infer ticket protection.

### Ranking
1. Hard constraints
2. Pareto dominance pruning
3. Component metrics
4. Preference-weighted ordering
5. Human-readable reasons

The pre-C003 starter uses exact Money for price comparisons and explanations.
Different native currencies are incomparable for Pareto dominance, and mixed-currency
ranking fails explicitly until a conversion policy exists. Its dimensionless scores
remain approximate. C002.1 supplies Money compatibility only; complete-TripOption
ranking remains reserved for C003 after the composition contracts and composer.

### Revalidation
Refreshes/re-prices the selected offer before redirect/booking.

### Observation Store
Stores permitted non-sensitive fare observations for history/analytics with source/time/market context.

### LLM Layer
- Natural-language query parsing
- Grounded comparison/explanation
- Never owns prices, schedules, dedupe or ranking math

## Search response lifecycle
1. Request accepted
2. Planner creates bounded provider jobs
3. Fast sources return
4. Normalize + group + rank
5. Stream initial results
6. Slower providers enrich result set
7. Client receives completion metadata and coverage report

## Failure model
Provider failures are expected. A search returns `partial` when at least one valid source succeeds. UI must not imply completeness.
