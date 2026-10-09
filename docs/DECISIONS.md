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
algorithm. Monetary representation is addressed separately in ADR-007; ranking policy
remains for C003.

## ADR-007: Exact minor-unit money at every boundary

Accepted for C002.1. Canonical Money is the strict JSON object
`{ amountMinor: string, currency, exponent }`. The amount is a nonnegative canonical
integer string of at most 38 digits; bigint is used internally and never crosses
JSON boundaries. Persistence uses NUMERIC(38,0), currency, exponent and metadata
version, with nonnegative/range/tax constraints and validated string bindings.

`MoneySchema` is bound to the immutable `iso4217-subset-v1` metadata snapshot:
JPY 0; EUR, GBP, INR, SEK and USD 2; KWD 3. The source is SIX ISO 4217 List One
published 2026-09-17; the URL, source hash, full contract and migration policy are
recorded in [DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#exact-money--c0021).
Unsupported currencies and mismatched exponents fail instead of defaulting to cents.

Source decimal text converts through integer arithmetic. Excess fractional zeros
normalize exactly; any nonzero excess digit fails. Numeric coercion and overflow
also fail; no authoritative fare or tax is silently rounded.
Exact comparison/addition/subtraction require compatible
currencies/exponents. Current ranking keeps its baseline policy, exposes exact Money
metrics, uses exact dominance/lowest-price checks, and rejects mixed-currency scoring.
Only dimensionless score approximations use numbers. Schedule Fingerprint V1 remains
unchanged and excludes money.

This foundation supports future multi-ticket totals without implementing TripOption,
FX, points, providers or C003. Future composition must preserve native currency
amounts, separate program-specific point quantities, and define any conversion and
rounding policies explicitly.


## ADR-008: Separate complete trips from commercial offers

Accepted for C002.2. TripOptions retain explicit safe TripSourceSnapshot projections
separately from BookingComponents and ordered segment references. Full FlightOffers
remain internal inputs; arbitrary providerMetadata never enters the serializable trip
contract. Projection preserves source observations without mutation. Provider IDs and
fingerprints are not durable commercial identities; local snapshot indexes resolve
references unambiguously. Every selected source segment must be flown exactly once,
in source order, with source journey boundaries preserved. Trip identity is ephemeral.
A complete trip is never represented as a fabricated FlightOffer.

Strict cash/award/cash-and-points quotes preserve exact obligations. Cash totals are
separate by currency; integer points are separate by normalized program ID. Neither
FX nor point valuation is implicit. Source award mapping remains a prerequisite for
real award ingestion; synthetic payment examples make no availability claim.

Pure helpers centrally derive totals, connection structure, durations and warnings.
Separate bookings require self-transfer disclosure. Protection within a component
requires an attributed explicit provider assertion; same provider/airport does not
establish protection. In-transit duration sums journey spans and excludes destination
stays. Full-envelope validation prevents omitted segments and inconsistent summaries.
Schedule Fingerprint V1, Money, current ranking and search execution stay unchanged.

The domain entry point is now a barrel over unchanged flight schemas and the new
payment/trip modules, avoiding a reverse dependency on orchestration. API wiring,
persistence, route search and ranking integration remain later tasks.

## Reserved direction: discovery suggestions are not commercial offers

Per the next-stage source strategy, C002.3 will separate candidate discovery from
fare verification. Rome2Rio is a candidate for experimentation, subject to verifying
its capabilities and access/usage rights. No verified capability or commercial-use
claim is made here. Route hints, estimates, scheduled data, quotes and revalidation
must retain their distinct evidence semantics. This direction is recorded only;
no source interfaces, registry or adapters are implemented in C002.2.

## ADR-009: Source-attributed discovery is separate from commercial inventory

Accepted for C002.3a. RouteDiscoverySource is a dedicated interface with a separate
request, multimodal LocationRef and RouteCandidate contracts. A candidate identifies
an observation worth investigating, never a bookable offer, complete trip or durable
physical schedule identity. Explicit leg order is preserved; source-native IDs remain
namespaced. No route merging, schedule fingerprinting or location reconciliation occurs.

Evidence targets an individual candidate/leg fact and names its source and available
observation/expiry references. Hints, estimates, scheduled and observed facts remain
distinct. Quoted/revalidated commercial facts are excluded from discovery. Heuristics
produce hints only; capabilities and other sources cannot upgrade evidence. Exact
Money can appear only inside an explicit EstimatedPrice wrapper with a declared or
unknown party basis. It is not a PaymentQuote or an authoritative ranking total.

Execution success/partial/timeout/error is independent of the accepted candidate list;
timeouts and errors preserve already validated observations. Future progressive batches
can carry the existing source/request/occurrence identities without inventing route
identity. Streaming and batch replay semantics are deferred.

Source definitions separately record access method, capabilities, production status
and transient/cache/persist/display/redistribute rights. Unknown is the conservative
default; known permission decisions and production approval require review attribution.
These declarations are not a legal engine or evidence of permission to call a source.
All public/canonical structures are strict, with safe references and fixed diagnostics;
credentials and private raw payloads stay outside them.

Rome2Rio remains an experimental discovery candidate with unverified production rights.
GTFS support is a contract direction, not a parser or claim of fare coverage. No real
adapter, MCP infrastructure, graph search, composer, FX, ranking or persistence changes
are included. The detailed contracts and downstream decisions are in
[DOMAIN_CONTRACTS.md](DOMAIN_CONTRACTS.md#route-discovery-source-contracts--c0023a).

## ADR-010: Stop Rome2Rio native mapping until its tool contracts are available

Accepted for implemented C002.3b-S scaffolding; C002.3b-M native payload mapping
remains blocked. The official connector listing confirms the endpoint and tool names, but
not their input/output schemas. A standard MCP initialization returned a Cloudflare
403 on 2026-10-06. No further protocol probing, scraping or bypass was attempted.

Record an experimental source definition with unknown capabilities and independent
unknown rights. Its attributed technical review is not production or usage approval.
The injected client consumes canonical intent and returns unknown payloads. Default
rights prevent calls. With an explicitly supplied permitted test configuration, the
scaffold maps client failures, isolates request data and bounds the caller's wait;
it cannot stop a transport that ignores cancellation. Even fulfilled payloads fail
closed while the mapper is blocked. Mock tests are not genuine source fixtures.
Do not invent tool parameters, native payload types or supposedly captured fixtures.
Implement native mapping only after genuine
tool contracts/responses can be obtained legitimately. Privacy, safe identifier
selection, evidence binding and real rights attribution remain C002.3b-M requirements.
See [ROME2RIO_ADAPTER.md](ROME2RIO_ADAPTER.md). C002.3c may proceed independently
using canonical RouteCandidate fixtures from C002.3a; it does not depend on completing
Rome2Rio native mapping.
