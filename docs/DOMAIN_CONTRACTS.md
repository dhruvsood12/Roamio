# Canonical domain contracts — C001 / C001.1 / C002 / C002.1

The exported Zod schemas in `packages/domain/src/index.ts` validate canonical data.
Adapters must explicitly map native data before parsing it. Parsing does not coerce
numbers, uppercase codes, sort segments, insert risk warnings, or invent missing
fare/provenance information. Canonical objects reject unknown keys; provider-specific
data belongs only in `providerMetadata`.

## Contract shapes

- `SearchRequest`: preserves the existing request fields and defaults (`adults: 1`,
  `maxStops: 1`, `currency: "USD"`). A missing/null return date is one-way.
- `Journey`: a strict object with a nonempty ordered `segments` tuple. A journey
  boundary is explicit domain data, never inferred from a time gap.
- `Itinerary`: a strict object with a nonempty ordered `journeys` tuple. Segment
  chronology is checked independently within each journey. Journey order is
  preserved; no chronology or airport-continuity comparison is made across journeys.
- `ProviderObservation`: the existing offer provenance fields: `provider`,
  `providerOfferId`, `retrievedAt`, nullable `expiresAt`, nullable `bookingUrl`,
  explicit `requiresRevalidation`, and `providerMetadata` (default `{}`).
- `FlightOffer`: replaces the former top-level `segments` with `journeys`, alongside
  the existing observation fields, offer identity, price, nullable fare facts, and
  warnings (default `[]`). Nested journey/segment refinements apply to every journey.
  The legacy top-level `segments` field is rejected rather than automatically migrated.
- `ProviderSearchResult`: gives the existing TypeScript result shape a runtime schema.
  Its exported type is inferred from that schema.
- `DurationMinutes`: a finite, nonnegative safe integer in whole minutes. Zero is
  allowed for a measured/rounded duration. Individual segments still require strictly
  positive elapsed time. Ranking rounds each journey's elapsed time to the nearest
  whole minute, preserving its previous rounding convention, and sums those values.

## Journey boundaries and travel metrics

```ts
type Journey = { segments: [Segment, ...Segment[]] };
type Itinerary = { journeys: [Journey, ...Journey[]] };
```

One-way travel has one journey. A round trip has explicit outbound and return
journeys. Open-jaw and multi-journey itineraries can be represented without treating
the time or surface movement between journeys as a connecting flight itinerary.
This representation does not add multi-city behavior to the public search request.

Within a journey, elapsed travel time runs from its first departure to its last
arrival, including all connection time. An overnight connection or a long stopover
stays inside that journey unless the source explicitly supplies a journey boundary.
No gap threshold splits or joins journeys.

Total travel duration is the sum of per-journey durations, not the time from the
trip's initial departure to its final arrival. The existing ranking metric `stops`
counts connections as `sum(max(journey.segments.length - 1, 0))`. Transitions between
journeys add neither duration nor connections. These metrics do not establish
connection bookability or technical-stop semantics.

The synthetic connecting round-trip regression has 900 outbound minutes and 840
return minutes, ten days apart. Its total is 1,740 minutes with two connections.
Changing the return origin from SAN to LAX does not create an airport-change
connection across the destination stay. Airport changes inside either journey
still require the existing warning.

## Marketing and operating identity

Segments require the following explicit fields; the old `flightNumber` is rejected:

```ts
marketingCarrier: CarrierCode;
marketingFlightNumber: FlightNumber;
operatingCarrier: CarrierCode | null;
operatingFlightNumber: FlightNumber | null;
```

The marketing pair identifies the marketed flight. The operating pair describes
the operating flight only to the extent supported by source data. For example,
marketed BA123 operated as AA456 is represented as `BA` / `123` and `AA` / `456`.

Each operating field is required but independently nullable. A known carrier with
an unknown operating number is retained as such; a known number with an unknown
carrier is also retained. Either null makes the operating identity incomplete.
Null never means "same as marketing". Missing properties fail validation instead
of triggering a default. Parsing preserves both identities and does not mutate them.

Never copy marketing identity into missing operating fields, guess an operating
number, or infer one from unrelated provider formatting. Adapters must map explicit
source facts. Equal marketing/operating values in synthetic tests are deliberately
known fixture facts, not an adapter fallback rule.

`FlightNumberSchema` retains C001's nonblank, unpadded, control-character-free string
validation. It preserves spelling, including leading zeros and suffixes. Carrier
codes retain the existing two-to-three-character syntax. C001.1 introduces no
carrier registry, alias resolution, prefix stripping or number normalization.

## Exact money — C002.1

All canonical totals, taxes and price metrics use one strict JSON-safe shape:

```json
{ "amountMinor": "12345", "currency": "USD", "exponent": 2 }
```

This represents USD 123.45. `amountMinor` is a nonnegative decimal integer string,
at most 38 digits: `"0"` is valid; signs, leading zeros, decimal points, scientific
notation, whitespace, numeric values and bigint values are rejected. The range is
0 through 10^38 − 1 minor units, inclusive. The exponent is a required integer and
must match the currency. Legacy `amount` and all undeclared fields are rejected.
JSON always carries the string, never a JavaScript number or bigint.

`MoneySchema` is bound to the immutable `CURRENCY_METADATA_V1` snapshot, version
`iso4217-subset-v1`, in `packages/domain/src/money.ts`. Its deliberately bounded
supported set is:

| Currency | Exponent |
| --- | ---: |
| JPY | 0 |
| EUR, GBP, INR, SEK, USD | 2 |
| KWD | 3 |

Values were checked against [SIX ISO 4217 List One](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml),
published 2026-09-17. The source XML SHA-256 is
`33139b438657d1cee116ba737807ea71d19d6de4b90f799a09c56f0cc6a1b0ff`.
The snapshot and exponent map are frozen; validation is deterministic and offline.
This list is a supported subset, not a complete currency registry or a claim about
provider coverage. Other codes fail Money validation; there is no default exponent.
The seven-currency subset is intentionally a temporary starter scope. Broader
currency coverage must be addressed before C006's real-provider integration and
expanded before broad real-provider coverage; this patch does not expand the list.
Expanding or changing the snapshot requires a new metadata version and a reviewed
compatibility/migration decision. Never reinterpret stored amounts under new rules.
The three-field Money shape is scoped to this versioned contract; persistence also
records the applicable metadata version. A future version must retain the old
interpretation or migrate it explicitly, not silently replace V1.

`moneyFromDecimalString(text, currency)` accepts unsigned plain decimal source text
with an integer part, no leading zeros except `0`, and optional fractional digits.
It derives the exponent from metadata, scales with bigint arithmetic, pads missing
fractional digits and returns canonical Money. Examples: USD `"0.29"` → `"29"`,
USD `"10"` → `"1000"`, JPY `"123"` → `"123"`, KWD `"1.234"` → `"1234"`.
Fractional digits beyond the currency exponent are removed only when every excess
digit is zero: USD `"1.2300"` → `"123"`, `"0.290"` → `"29"`, `"10.000"` → `"1000"`.
This is exact normalization, not rounding. Any nonzero excess digit fails, including
USD `"1.234"`, `"1.2301"` and `"0.001"`. The canonical 38-digit limit still applies
after normalization. No source rounding, whitespace trimming, exponent notation,
locale parsing or numeric coercion occurs.
Output overflow fails. Adapters must retain original decimal text or losslessly
parsed numeric tokens; converting an already rounded JavaScript number to a string
cannot recover its original value and is not an authorized normalization strategy.

`moneyFromMinorUnits(bigint, currency)` derives the exponent and checks the canonical
range. `compareMoney` returns −1, 0 or 1; `addMoney` and `subtractMoney` return new
Money objects. They validate both operands and use bigint internally. Different
currencies throw; mismatched exponents fail schema validation. Addition overflow and
negative subtraction fail rather than rounding, wrapping or clamping. Helpers do
not mutate their inputs. No FX conversion, rates, cash rounding or points valuation
is implemented.

`totalPrice` remains tax-inclusive. Provided taxes must be valid Money in the same
currency and canonical exponent, and cannot exceed the total by exact integer
comparison. Invalid nested amounts produce schema issues rather than exceptions
from BigInt parsing. Null/absent taxes remain unknown, not zero.

The ranking starter now exposes `RankMetrics.price` as Money. Pareto dominance uses
exact same-currency comparisons; different currencies are incomparable and cannot
dominate one another. `rankOffers` rejects a mixed-currency batch with a `RangeError`
before scoring. Consequently the current `searchAll` also rejects such a batch;
the pure grouper still preserves its observations. C004 must handle this explicitly
without inventing conversion rates or dropping observations.

Within one currency, the existing weights, zero-minimum policy and stable ordering
of score ties remain. Monetary comparisons and lowest-price explanations are exact.
The starter's price penalty computes an integer quotient and a fractional part,
truncated to 12 decimal places, before converting that dimensionless score to number.
This approximation never changes a Money value or a tax/dominance comparison. Tiny
price differences can tie in the approximate score; exact Pareto comparisons and
cheapest explanations still distinguish them. C003 ranking policy is not implemented
by this compatibility change.

## Validation rules

- Airport and currency codes are exactly three uppercase ASCII letters; market codes
  are two. Carrier codes retain the existing two-to-three-character range, restricted
  to uppercase ASCII letters/digits. These are syntax checks, not registry lookups.
  Money separately requires a supported currency from the versioned metadata above.
  `SearchRequest.currency` retains its existing syntax validation and USD default;
  this patch does not implement request eligibility or provider currency capabilities.
- Identifiers, flight numbers and optional aircraft/fare-brand strings cannot be
  empty, padded with whitespace, or contain control characters. Flight numbers are
  not assumed to be numeric or assigned a provider-specific format.
- Dates must be real calendar dates in `YYYY-MM-DD` format, including leap-year checks.
  Return dates cannot precede departure dates; same-day returns are allowed.
- Timestamps require seconds and `Z` or an explicit colon-separated numeric offset.
  Fractional seconds are limited to one through three digits to match JavaScript
  millisecond comparisons. Unknown offsets (`-00:00`) are rejected. Offsets are
  retained, and comparisons use instants rather than local wall-clock strings.
- Segment airports differ and arrival follows departure. Within each journey,
  every subsequent segment departs at or after the preceding arrival. Zero-gap
  connections are structurally valid; this says nothing about minimum connection
  time or bookability. These comparisons stop at each explicit journey boundary.
- Origin/destination arrays are nonempty, internally unique, and disjoint. Cabin
  selections are nonempty, unique, and restricted to the existing cabin enum.
  Adults remain integers from 1–9 and maximum stops from 0–3. Additional passenger
  categories are unmodeled and rejected instead of silently ignored.
- Money uses exact nonnegative minor-unit strings, bounded to 38 digits, with a
  supported currency and its validated exponent. Taxes use the total-price currency
  and exponent and cannot exceed the total by exact comparison.
- Baggage counts are nonnegative safe integers or explicit `null`. Refundability and
  changeability remain booleans or explicit `null`. Missing required nullable fields
  fail validation; `false`, `0`, and `null` remain distinct.
- Provenance, nullable expiry/booking URL and the revalidation flag must be explicit.
  Known expiry follows retrieval. Booking URLs are absolute HTTP(S) URLs without
  embedded credentials, whitespace, control characters or backslashes. A null URL and false revalidation
  flag are permitted and do not establish that the offer is bookable.
- Warnings come from the existing enum and cannot repeat. An offer spanning distinct
  cabins must include `mixed_cabin`; a gap between adjacent arrival/departure airports
  within any one journey must include `airport_change`. The existing offer-wide
  mixed-cabin rule and provider-reported warnings are preserved; central warning
  derivation is not part of C001.1.
- Provider search completion cannot precede start; equal instants are allowed.
  Success may have zero offers and cannot have an error code. Error/timeout results
  cannot contain offers. Every nested offer must name the result's provider.

## Assumptions and unresolved questions

- `totalPrice` is tax-inclusive; all authoritative monetary arithmetic is exact.
  FX, provider-specific rounding, currency-policy updates and cash-versus-points
  valuations still need explicit contracts. Database documentation now specifies
  exact storage, but no database implementation or migration is introduced.
- Registry membership and route validity require maintained reference data. A
  well-formed but unassigned airport/carrier/market code can still parse. Currency
  syntax alone can pass `CurrencyCodeSchema`; Money additionally enforces its subset.
- The segment contract still requires a known cabin and marketed identity. Missing
  operating facts are explicit nulls. Unknown observed cabins remain an unresolved
  contract question outside C001.1; they must not be guessed.
- Known expiry is modeled as the end of an observation's validity interval after
  retrieval. Historical observations that are expired now remain valid schema data;
  an offer already expired at retrieval fails this contract. If sources need to
  retain those observations, that use case needs an explicit expiry-state decision.
- No current-time checks are used. Freshness policy and revalidation before redirect
  remain separate responsibilities; `requiresRevalidation` does not assert a
  provider capability. Cached observations may predate a provider search call.
- Explicit journeys do not model ticket protection or airport time zones. They
  cannot prove self-transfer status, distinguish every
  stopover/surface sector, or derive minimum connection times, overnight/short/long
  connection warnings. Known split-ticket/self-transfer offers must carry the
  existing `self_transfer` warning, but the schema cannot detect an omitted warning
  without an explicit protection/ticketing field. Airport changes alone do not
  establish self-transfer.

## Schedule Fingerprint V1

Schedule Fingerprint V1 performs exact normalized schedule matching, not fuzzy itinerary reconciliation.

`itineraryFingerprint(offer)` accepts a canonical `FlightOffer` and returns
`ScheduleFingerprint | null`. A known fingerprint is `fb:schedule:v1:` followed
by 64 lowercase hexadecimal characters: Node's built-in SHA-256 digest of the
UTF-8 bytes produced by `JSON.stringify` on this precise array structure:

```ts
[
  "flightbrain-schedule",
  1,
  [
    [ // first journey, in supplied order
      [origin, destination, operatingCarrier, operatingFlightNumber,
       normalizedDepartureInstant, normalizedArrivalInstant],
      // subsequent segments, in supplied order
    ],
    // subsequent journeys, in supplied order
  ],
]
```

The serialization has no added whitespace or trailing newline. It contains only
arrays, strings, and the numeric version. Journey/segment ordering and all journey
boundaries are significant. Nested JSON preserves structure even when flight
numbers contain delimiter characters, quotes, backslashes or JSON-looking text.
No segments or journeys are sorted, flattened, inferred, or dropped.

Both scheduled timestamps are normalized using `new Date(timestamp).toISOString()`.
For valid canonical timestamps this produces UTC with three fractional digits.
`06:00:00Z` and `08:00:00+02:00` on the same date converge; `.1` and `.100` seconds
also converge. Actual differences of even one millisecond remain different
signatures. Arrival differences count just as departure differences do. There is
no minute rounding or schedule-tolerance window. Original timestamp strings remain
unchanged in each offer. These helpers assume schema-validated canonical input;
they do not replace adapter mapping or runtime provider validation.

Carrier codes and operating flight numbers are opaque canonical strings, used
exactly as supplied. `AA` and `AAL` remain different. Numbers `123`, `00123`, `123A`
and `AA123` remain different. V1 performs no alias lookup, case conversion, numeric
parsing, prefix stripping, internal-character removal or Unicode normalization.
Source-specific normalization belongs in future adapters and must be supported by
source facts. No registry or network data is consulted by fingerprinting.

The payload excludes offer IDs, provider/providerOfferId, all marketing identity,
price, currency, taxes, fare brand, cabin, baggage, refundability, changeability,
booking URL, retrieval/expiry, revalidation flags, warnings, aircraft and provider
metadata. These remain commercial/observation facts on each original offer. Equal
schedule fingerprints do not establish equal fares, availability or connection
protection. This is an exact schedule identity, not a globally permanent flight ID;
a changed schedule produces a different signature.

Every segment must have both an operating carrier and an operating flight number.
If either is null anywhere, the whole fingerprint is null. Partial identity stays
valid canonical data. Missing operating properties also return null defensively,
although the canonical schema rejects their omission. There is no marketing
fallback, inference or shared unknown identity. False negatives are acceptable;
false-positive merges are not.

V1's payload, field order, normalization and hashing semantics are immutable.
Future semantic changes require a new version such as V2, never silently changing
the meaning of an existing persisted V1 fingerprint. Fixed known-digest tests lock
the format. The C001.1 unversioned JSON key has been removed; any consumer holding
one must recompute from canonical observations, not relabel it as V1.

## Conservative itinerary grouping

`groupOffersByItinerary(offers)` is a pure operation exported from the orchestrator:

```ts
type ItineraryGroup = {
  scheduleFingerprint: ScheduleFingerprint | null;
  offers: FlightOffer[];
};
```

All offers with the same known V1 fingerprint share one group. Every input
occurrence is retained, including different prices, currencies, cabins, fare
conditions, warnings and providers, repeated IDs, and even a repeated object.
Grouping does not select a preferred offer or deduplicate observations.

Each null-fingerprint occurrence gets its own singleton group. Even two occurrences
of the same unknown-identity object remain separate. Null is never an equality key.
No physical fingerprint is fabricated from provider IDs, marketing identity or
input position. Known fingerprints may identify their schedule group; unknown
groups have no physical schedule identity.

Group membership and fingerprints are independent of provider/input ordering.
Output groups follow first encounter and offers within each group retain input
order. These arrays are not ranked or sorted, and their positions are not identity.
The helper creates fresh group objects/arrays, retains the original offer references,
and never mutates the input array, offers, journeys, segments or timestamps. It has
no cache, clock, randomness or dependency on provider completion timing.

`searchAll` delegates to this helper and adds its existing `rankedOffers` separately.
Its group field is now `scheduleFingerprint`, replacing the transitional
`fingerprint` field. Ranking, provider execution and search status semantics are
otherwise unchanged; grouping does not imply complete source coverage.

## Scope and verification

The schema tests use synthetic data only. They cover valid and invalid primitives,
calendar/offset boundaries, cross-field invariants, malformed provider payloads,
nested refinements, unknown/null preservation, strict keys, and input immutability.
C001.1 migrates the existing domain/ranking fixtures to explicit journeys and
deliberately specified flight identities. It adds round-trip, open-jaw, multi-journey,
stopover, codeshare, unknown-identity and conservative grouping regressions. Existing
provenance, expiry, passenger, cabin, warning and provider-result rules remain.
C002.1 replaces the numeric money contract and migrates its fixtures explicitly.

C002 adds fixed digest vectors, fresh-process/time-zone stability, equivalent
instant normalization, millisecond differences, opaque identifiers, codeshare
convergence, every included/excluded field, structural collision regressions,
ordering/boundaries, null singleton behavior, commercial-offer retention, provider
order permutations and deeply frozen input tests. It replaces the transitional
offset-spelling test with the required instant-equivalence regression.

C002.1 adds focused money and integration tests for every supported exponent,
strict text/JSON boundaries, 38-digit limits, invalid nested provider money, overflow,
exact addition/comparison/taxes, currency incompatibility and frozen inputs. The C002
golden fingerprint expectations and production fingerprint implementation are unchanged.

`vitest.config.ts` resolves the aliases already declared in `tsconfig.json`; the
starter test otherwise fails to import `@flightbrain/ranking`. Run `npm test` and
`npm run typecheck` after installing the declared dependencies. No lint script is
configured. Node type declarations support the test configuration's standard-library
import, and the configuration is included in the project type-check.

These rules apply when schemas are parsed. Runtime validation in provider handling,
enforced deadlines, retained partial provider offers and progressive coverage remain
for C004 and its prerequisite contracts. C001.1 journey metrics and C002 identity/
grouping behavior remain unchanged. C002.1 adds exact money and only the necessary
ranking compatibility changes. No provider, UI, database implementation, FX,
freshness redesign, TripOption, route search or award model is implemented.

The next reserved task is **C002.2 — Trip composition contracts**, followed by
C002.3's bounded composer and C003's complete-TripOption ranking. Composition must
retain native per-currency amounts until an explicit FX contract exists; points
quantities and programs need separate contracts and must not be represented as Money.
