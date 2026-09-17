# Security / Compliance Boundaries

## V1 data minimization
Collect only search criteria and optional account preferences. Do not collect passport details, card data, airline passwords, or unnecessary PII.

## Secrets
- Server-side only
- Secret manager in production
- Provider keys never exposed to browser
- Rotate and scope credentials

## External access
- Integrate only approved endpoints/accounts
- Respect quotas, attribution, caching and commercial-use restrictions
- No CAPTCHA bypass, credential stuffing, session theft, anti-bot evasion, or access-control circumvention

## Logging
- Structured request/search IDs
- Redact secrets and user PII
- Store provider errors without raw sensitive payloads by default

## Booking scope
If FlightBrain later becomes merchant/booking agent, run a separate compliance program covering payments/PCI, fraud, refunds/exchanges, customer support, tax/regulatory duties, and supplier agreements before implementation.
