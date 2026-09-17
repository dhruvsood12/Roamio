# Database Schema (draft)

## searches
- id UUID PK
- request_json JSONB
- user_id nullable
- created_at
- completed_at nullable
- status

## provider_searches
- id UUID PK
- search_id FK
- provider
- status
- latency_ms
- offer_count
- error_code nullable
- started_at / finished_at

## itineraries
- id UUID PK
- fingerprint indexed
- segment_signature JSONB
- first_departure_at
- final_arrival_at
- stops

## offer_observations
- id UUID PK
- search_id FK
- itinerary_id FK
- provider
- provider_offer_id
- total_amount_minor
- currency
- fare_brand nullable
- cabin_summary
- refundable nullable
- changeable nullable
- baggage_json
- warnings_json
- retrieved_at
- expires_at nullable
- raw_payload_pointer nullable

## saved_searches (later)
- id, user_id, search_template_json, alert_policy_json, created_at

## price_history (later)
Only store observations when provider agreements permit retention.
- itinerary_market_key
- provider
- travel_date
- observed_price_minor
- currency
- observed_at

## Design constraints
- Do not store provider secrets in DB rows.
- Do not store passenger passport/payment data for metasearch MVP.
- Keep raw provider payload retention configurable per provider agreement.
