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
- total_amount_minor NUMERIC(38,0) NOT NULL
- taxes_amount_minor NUMERIC(38,0) nullable (same currency/exponent as total)
- currency CHAR(3) NOT NULL
- currency_exponent SMALLINT NOT NULL
- currency_metadata_version TEXT NOT NULL
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
- observed_price_minor NUMERIC(38,0) NOT NULL
- currency CHAR(3) NOT NULL
- currency_exponent SMALLINT NOT NULL
- currency_metadata_version TEXT NOT NULL
- observed_at

## Exact money storage — C002.1

The canonical/API Money shape is `{ amountMinor: string, currency, exponent }`.
`amountMinor` maps directly to `NUMERIC(38,0)` as a validated decimal-string bind
parameter; no multiplication, division or floating-point conversion is involved.
Read database numeric values as strings, never through a driver's number parser.
Reconstruct and validate Money with the stored currency, exponent and the applicable
versioned contract. Zero is valid; unknown taxes are SQL NULL.

The initial metadata version is `iso4217-subset-v1`, with exponents JPY 0; EUR, GBP,
INR, SEK, USD 2; KWD 3. See [DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#exact-money--c0021)
for the immutable source snapshot. An eventual currency-metadata reference table
should key `(metadata_version, currency, exponent)` and enforce that tuple on every
observation/history row. Preserve historical metadata; never silently reinterpret
old amounts when adding a new version.

Require checks bounding each monetary column to 0 through 10^38 − 1 inclusive,
and `taxes_amount_minor <= total_amount_minor` when taxes are present. Taxes share
the row's currency/exponent. Do not use FLOAT, REAL, DOUBLE PRECISION or a
locale-dependent MONEY type. NUMERIC scale casts may round fractional input, so
validate canonical integer-string syntax and precision **before** database binding;
database scale is not a substitute for the domain boundary.

No database code, migrations, FX values, points valuation or TripOption persistence
is implemented in C002.1. Future multi-ticket totals must retain native currencies;
they cannot be summed into one amount without an explicit conversion contract.

## Design constraints
- Do not store provider secrets in DB rows.
- Do not store passenger passport/payment data for metasearch MVP.
- Keep raw provider payload retention configurable per provider agreement.
