# Public API Contract (draft)

## POST /api/search

Request
```json
{
  "origins": ["ARN"],
  "destinations": ["SAN"],
  "departureDate": "2026-10-10",
  "returnDate": "2026-10-20",
  "adults": 1,
  "cabins": ["economy", "business"],
  "maxStops": 1,
  "currency": "USD",
  "market": "SE"
}
```

Response shape
```json
{
  "searchId": "...",
  "status": "partial|complete|failed",
  "coverage": {
    "attempted": ["provider-a"],
    "succeeded": ["provider-a"],
    "timedOut": [],
    "failed": []
  },
  "itineraries": [],
  "generatedAt": "..."
}
```

## POST /api/offers/:offerId/revalidate
Returns the latest provider-authoritative version of an offer when supported. The client must handle price/fare changes explicitly.

## Money contract — C002.1

Every canonical `totalPrice`, provided `taxes`, and monetary ranking metric uses:

```json
{ "amountMinor": "12345", "currency": "USD", "exponent": 2 }
```

`amountMinor` is a canonical nonnegative integer string with at most 38 digits;
`"0"` is valid. Numeric JSON amounts, bigint, signs, leading zeros, decimal points,
exponent notation, whitespace and the legacy `amount` field are rejected. Clients
must retain the string and use integer/decimal arithmetic, never `parseFloat` or
`Number` for authoritative monetary calculations.

The required exponent is validated against `iso4217-subset-v1`: JPY 0; EUR, GBP,
INR, SEK and USD 2; KWD 3. Unsupported currencies and mismatched exponents fail.
This version is a frozen contract, not a runtime lookup; source/version and exact
conversion rules are in [DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#exact-money--c0021).
Future metadata changes require explicit versioning/migration, not reinterpretation
of existing payloads. The three-field Money object has no implicit/default exponent.

For example JPY 123 is `{"amountMinor":"123","currency":"JPY","exponent":0}`;
KWD 1.234 is `{"amountMinor":"1234","currency":"KWD","exponent":3}`.
Totals remain tax-inclusive. Provided taxes must share currency/exponent and be
less than or equal to the total. Unknown taxes remain null/absent, never fabricated.

There is no FX conversion or cross-currency price ordering in C002.1. Schedule
groups may retain different native currencies, but the current ranking starter
rejects mixed-currency batches explicitly. The future API/orchestrator must expose
that incompatibility without implying a global cheapest result. These are contract
updates only. C002.2 defines TripOption/payment contracts in the domain package,
but search responses and ranking are not wired to them. C007 API implementation
and a public trip/source-envelope response format remain pending.
The canonical TripOption's `sourceOffers` contains strict `TripSourceSnapshot`
projections, not full internal observations. The explicit field allowlist and preserved
validation rules are documented in [DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#source-references-and-explicit-travel).
Arbitrary `providerMetadata` and raw provider objects are excluded from this boundary.

## GET /api/search/:searchId/events
Future SSE endpoint for progressive provider results. Events: `provider_started`, `provider_completed`, `results_updated`, `search_completed`.

## Error principles
- Provider error does not become HTTP 500 if another source succeeded.
- Validation errors are 400.
- No inventory is a successful search with zero offers.
- Upstream auth/configuration failures are observable server-side but sanitized to clients.
