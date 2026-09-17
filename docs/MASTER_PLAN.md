# FlightBrain Master Plan

## North star
Answer: **What is the smartest bookable way for this traveler to make this trip right now?**

That means combining price, time, stops, cabin, fare conditions, booking source quality, nearby airports, flexible dates, and eventually award points—while clearly showing trade-offs.

## Product sequence

### Phase 0 — contracts and mocks
- Canonical schemas
- Provider contract
- Ranking contract
- Mock source
- Fake results UI
- Tests

### Phase 1 — cash metasearch MVP
- 1 production shopping API (recommended first: Duffel or another source you are approved for)
- Concurrent provider orchestration
- Partial-result streaming semantics
- Deduplication
- Revalidation
- Cheapest / Fastest / Best trade-off

### Phase 2 — source breadth
- Add approved Skyscanner / Expedia / Travelport / Amadeus integrations as contracts permit
- Source health dashboard
- Search-cost budget per request
- Coverage telemetry

### Phase 3 — flexible search
- Nearby-airport graph
- Date-window exploration
- Airport/date pruning to cap combinatorial explosion
- Fare history observations
- Deal rarity model

### Phase 4 — award intelligence
- Commercially licensed award source(s)
- User-defined point valuations
- Transfer partners/bonuses
- Cash-vs-points opportunity-cost comparison
- Mixed-cabin warnings

### Phase 5 — trip intelligence
- Price alerts
- Saved searches
- Natural-language intent parsing with GPT-6 Astra
- Explain/compare results using grounded structured data only

### Phase 6 — live flight tracking
Separate service and data model for operational status, delays, gates, aircraft and alerts.

## V1 success metrics
- Search success rate > 99% at orchestrator level even when a provider fails
- First useful result target < 2.5s where upstream permits
- 100% offers have provenance
- 100% selected offers revalidated when provider supports it
- Duplicate itinerary recall measured with fixture corpus
- Ranking explanations exactly match score components
- Zero LLM-generated fare facts

## Kill criteria
Stop or pivot if:
- Production API access cannot be obtained for enough inventory to offer differentiated coverage.
- Per-search upstream cost cannot be reconciled with affiliate/booking/subscription economics.
- Price mismatch/revalidation failure materially erodes trust.
- Award data cannot be licensed commercially on viable terms.
