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

## GET /api/search/:searchId/events
Future SSE endpoint for progressive provider results. Events: `provider_started`, `provider_completed`, `results_updated`, `search_completed`.

## Error principles
- Provider error does not become HTTP 500 if another source succeeded.
- Validation errors are 400.
- No inventory is a successful search with zero offers.
- Upstream auth/configuration failures are observable server-side but sanitized to clients.
