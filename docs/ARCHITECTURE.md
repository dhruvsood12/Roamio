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

### Trip composition contracts (C002.2)
The intended downstream pipeline is:

`Provider FlightOffers → Schedule Groups → Trip Composer → TripOptions → Ranking`

A FlightOffer is a commercial source observation; a TripOption is a complete selected
way to travel. BookingComponents reference original observations and explicit ordered
segment paths preserve both commercial and journey boundaries. A self-contained
safe source snapshot list permits full-segment coverage validation without copying
flight schedules into components. Internal plans retain full FlightOffers; serializable
TripOptions use strict TripSourceSnapshots with explicitly selected fields and no
providerMetadata. Original observations remain unchanged. No component is called a
Ticket or assumed to be one PNR.

The pure trip builder validates an explicit selection and derives native-currency
cash totals, program-specific points, travel summaries, connections and warnings.
It does not discover routes. Independent bookings are self-transfers; protection
within a booking requires attributed source evidence and otherwise remains unknown.
The full contract is in [DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#trip-composition-contracts--c0022).

### Future route discovery (reserved C002.3)
The planner will distinguish **discovery sources**, which propose candidate routes,
from **commercial offer sources**, which quote purchasable travel. Candidate hints,
estimates and reference schedules cannot become PaymentQuotes or evidence of current
availability merely by normalization. Price revalidation is a separate source event.
Future evidence must attach to individual facts (route, schedule, price), not imply
that one source-wide confidence label verifies every fact.

Rome2Rio is a proposed experimental discovery candidate; its current tools, coverage,
automation permissions, commercial access, retention and redistribution rights have
not been verified here. Any adapter must remain discovery-only and unavailable for
production until those questions are resolved. No Rome2Rio dependency or connection
is installed in C002.2. Future source-registry work should record capabilities,
access method, rights, authentication, quotas, cost, coverage and freshness with
attributed verification, rather than assuming an app's availability grants backend
usage rights. Multimodal discovery will need separate mode/location contracts;
C002.2 continues to describe flight segments only.

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
