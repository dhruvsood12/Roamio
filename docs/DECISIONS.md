# Architecture Decision Records (initial)

## ADR-001: API-first, not scraper-first
Accepted. Reliability, legality, maintainability and commercial viability outweigh theoretical source count.

## ADR-002: Metasearch before booking
Accepted. Redirect/deeplink first. Booking adds payments, servicing, exchanges/refunds and regulatory/support scope.

## ADR-003: Tracking is a separate bounded context
Accepted. Fare shopping and flight operations have different sources, caching, identifiers and latency requirements.

## ADR-004: Deterministic ranking before ML
Accepted. Explainable metrics and Pareto filtering are testable and easier to trust.

## ADR-005: LLM is interpreter/explainer, not source of truth
Accepted. GPT-6 Astra parses intent and explains structured results, but does not invent or alter provider observations.

## ADR-006: Versioned exact schedule identity with conservative grouping

Accepted for C002. `fb:schedule:v1:<sha256>` hashes UTF-8 JSON containing the
`flightbrain-schedule` namespace, version `1`, ordered journeys, and ordered
segment tuples of origin, destination, operating carrier, operating flight number,
UTC departure and UTC arrival. Both instants retain milliseconds. The exact
serialization and grouping contract are specified in [DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#schedule-fingerprint-v1).

Schedule Fingerprint V1 performs exact normalized schedule matching, not fuzzy itinerary reconciliation.

Carrier codes and flight numbers retain their exact canonical spelling. Marketing
identity and every commercial/observation attribute are excluded. Any incomplete
operating identity yields null and a separate singleton group for each occurrence.
Known equal schedules share a group while retaining every commercial offer and its
provenance. Group membership is independent of provider order; output arrays preserve
encounter order and are not stable identifiers or ranking decisions.

False negatives are acceptable; false-positive merges are not. No alias resolution,
number rewriting, time tolerances or network reference data are introduced. A V1
fingerprint describes the exact represented schedule, not a permanent flight ID or
equivalent fare/protection terms. Future semantic changes require V2; persisted V1
meaning must never change. The unversioned C001.1 keys are replaced, with no fallback
algorithm. Monetary representation and ranking are deferred to the exact-money patch
and C003 respectively.
