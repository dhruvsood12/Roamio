# Canonical domain contracts — through C002.2

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

C002.2 adds the separate trip contracts below. C002.3 remains reserved for discovery
contracts, an experimental discovery adapter and the bounded composer, followed by
C003's complete-TripOption ranking. Existing search/ranking execution is unchanged.


## Trip composition contracts — C002.2

The intended pipeline is `SearchRequest → Provider FlightOffers → Schedule Groups →
Trip Composer → TripOptions → Ranking`. C002.2 introduces representation and pure
validation/derivation helpers only. No route is discovered, priced or ranked here.
The package entry point remains `@flightbrain/domain`; the unchanged pre-C002.2
flight schemas now live in `flights.ts`, with payments and trips in separate modules.
This avoids circular imports without changing existing exports or behavior.

| Concept | Meaning |
| --- | --- |
| Segment | One source flight leg with marketed/operating identity and exact scheduled instants. |
| Journey | An explicit ordered flight sequence; boundaries separate outbound, return or other requested travel. |
| FlightOffer | A commercial source observation, including the complete offered schedule and provenance. |
| TripSourceSnapshot | An explicitly allowlisted serializable projection of one selected source observation, excluding internal provider metadata. |
| Schedule Group | Offers with an exact known physical fingerprint; each unknown occurrence remains separate. |
| BookingComponent | One independently purchasable selection, not an issued ticket or PNR. |
| Connection | A transition between adjacent flights within one trip journey, with structural facts and attributed protection. |
| PaymentQuote | Explicit cash, award, or genuine single-booking cash-and-points obligations. |
| TripOption | A complete explicitly selected travel plan, its safe source snapshots, booking boundaries and derived summaries. |
| TripPaymentSummary | Exact cash totals by native currency and points totals by program; no universal cost. |

### Source references and explicit travel

`BookingComponent` contains `id`, `provider`, `providerOfferId`, `offerId`,
`sourceOfferIndex`, nullable `scheduleFingerprint`, `order`, and `payment`.
Component IDs are unique within a trip; neither they nor the TripOption ID are
permanent hashes or globally durable provider identities. Order is zero-based,
contiguous and equal to array position, matching first use in the explicit path.

An internal `TripPlan` retains complete `FlightOffer` observations. A serialized
TripOption holds each selected `TripSourceSnapshot` once in `sourceOffers`, separately
from `bookingComponents`. Each component references one snapshot by its
local index; provider, provider offer ID and observation ID must match that exact
snapshot. All snapshots are used exactly once. Repeated provider/observation IDs
are permitted and do not collapse snapshots. This self-contained in-memory envelope
lets the canonical boundary validate complete source coverage without an external
resolver, copying schedules into components, or inventing durable IDs. It is not a
new persistence layout; a future API may use a separately validated source envelope.

`TripSourceSnapshotSchema` is a strict, explicit allowlist of the following fields:

| Fields retained | Purpose |
| --- | --- |
| `id`, `provider`, `providerOfferId` | Match the selected component to its source observation. |
| `journeys` | Preserve every canonical segment and journey boundary for complete coverage, chronology, connections and schedule identity. |
| `retrievedAt`, `expiresAt`, `requiresRevalidation`, `bookingUrl` | Preserve observation freshness and the existing booking/revalidation context. |
| `totalPrice`, optional nullable `taxes` | Validate exact component cash obligations and the original inclusive-total/tax invariants. |
| `fareBrand` (optional/nullable); `refundable`, `changeable`, `checkedBags`, `cabinBags` (required/nullable) | Preserve the selected component's normalized commercial conditions, without treating equal schedules as equivalent fares. |
| `warnings` | Preserve canonical source disclosures and derive trip warnings. |

The existing nested Journey/Segment and Money schemas remain strict. The nullable
schedule fingerprint remains on BookingComponent; it is not duplicated in snapshots.
Snapshot validation reuses all existing FlightOffer refinements, including expiry,
tax comparisons and required source warnings. The internal validator's default empty
metadata object is never part of the snapshot output.

`providerMetadata` is intentionally absent, even when empty. No generic JSON field,
raw provider response or alternate metadata escape hatch is allowed. The builder
selects fields explicitly rather than spreading the source or deleting a blacklist.
Future FlightOffer fields do not automatically become serializable snapshot fields.
Directly parsing a snapshot with extra fields fails instead of silently accepting them.
Provider-specific credentials, private fare codes and raw responses stay in the
original internal observation. Projection neither mutates nor deletes those facts.
The existing TripPlan JSON-compatibility check on internal metadata remains; JSON
compatibility does not authorize publication. FlightOffer itself is unchanged.

A `TravelSegmentRef` is `{ componentIndex, journeyIndex, segmentIndex }`, where the
last two indexes address the selected source offer. Each `TripJourneyPlan` supplies
`requestedOrigin`, `requestedDestination` and a nonempty ordered sequence of these
references. Endpoints are already resolved actual airports, not metropolitan codes
or a new nearby-airport search model. Each endpoint must match the first/last flown
segment of that requested journey. Date/passenger/cabin request matching remains
for the future composer; this contract does not assert full SearchRequest eligibility.

Every selected source segment must appear exactly once, in source order. Source
journeys cannot be split across trip journeys, or merged with another journey from
the same source. Several different offers can contribute to one trip journey.
A round-trip component can recur on the return after another component; component
order must not be confused with one contiguous block of travel.

Chronology must be nondecreasing throughout the whole trip, including across journey
boundaries. Adjacent airports within a journey may differ, but this creates an
explicit airport-change connection, not proof that a ground transfer is feasible.
Across journeys, different airports represent open-jaw/requested travel boundaries,
not implicit connections. Every selected flight is intended to be flown: omitting
an onward booked leg (hidden-city behavior), a return journey, or any other source
segment is invalid. The validator cannot determine a person's subsequent intent.

The optional identity knowledge is conservative: a known fingerprint must have V1
syntax, and incomplete operating identity requires null. Complete source identity
may still retain null. The domain does not duplicate the orchestrator's hashing
algorithm or use this supplied reference to resolve, merge or prove equality of
offers. Producers must attach the fingerprint computed by the existing C002 helper
for that observation; digest-to-schedule verification remains that producer's duty.

### Payment and point contracts

All variants are strict discriminated objects:

```ts
CashPaymentQuote = { kind: "cash"; amount: Money };
AwardPaymentQuote = {
  kind: "award"; program: LoyaltyProgramRef; points: PointsAmount;
  taxesAndFees: Money[];
};
CashAndPointsPaymentQuote = {
  kind: "cash_and_points"; program: LoyaltyProgramRef; points: PointsAmount;
  cash: Money[];
};
```

`PointsAmount` is a canonical nonnegative integer string with at most 38 digits,
including zero. No signs, leading zeros, decimals, exponent notation, whitespace or
numeric coercion. `addPoints` and `comparePoints` use bigint internally; addition
beyond 38 digits fails. These helpers do not give points a currency or program;
program separation is enforced by the payment aggregation helper.

`LoyaltyProgramRef` is the minimal strict `{ id }` object. IDs are 1–64 ASCII
characters: lowercase letter first, followed by lowercase letters/digits and single
hyphens between nonempty groups. The domain assigns stable IDs; no registry,
provider alias inference or display-name reconciliation is implemented.

An award quote's `taxesAndFees` is required and complete; `[]` explicitly means no
cash due, never missing/unknown fees. Cash-and-points requires a nonempty cash array.
Zero obligations are retained explicitly. Multiple cash line items in one currency
are additive. These quotes must be authoritative normalized commercial facts from
the selected provider offer, not estimates, point valuations or route hints.

For a cash component, `amount` must exactly equal the source offer's tax-inclusive
`totalPrice`; its `taxes` are not added again. Award/hybrid quotes are explicit input
facts attributed through the component's provider/offer reference. They are never
derived from the legacy cash total. The current FlightProvider still returns only
cash-shaped FlightOffers: real award ingestion needs an explicit source/payment
mapping contract before integration. C002.2's synthetic award examples demonstrate
representation only, not provider support, availability, or cash/award equivalence.

`summarizePayments(quotes)` validates its inputs and returns:

```ts
{
  cashByCurrency: Money[];
  pointsByProgram: { program: LoyaltyProgramRef; points: PointsAmount }[];
}
```

Cash is added only within one currency using the C002.1 helpers and validated
exponents. Points are added only within one program ID. Both lists have unique keys
in ascending ASCII order, independent of input ordering. Zero entries are retained;
empty lists mean no obligation in that category. Arithmetic overflow is rejected.
No FX, point exchange, cents-per-point, effective cost or universal price is produced.
The trip can contain INR 31,000 and USD 509 simultaneously. The hybrid example
retains USD 415.60, Aeroplan 55,000 and United MileagePlus 7,500 separately. Mixing
cash and award components does not turn their quotes into `cash_and_points`.

### Connections, protection and exact duration

One connection is derived for every adjacent pair of references within each trip
journey. It contains `journeyIndex`, `fromSegmentIndex`, both component indexes,
arrival/departure airports and instants, `durationMilliseconds`, `airportChange`,
`crossesBookingBoundary`, `protection` and `evidence`. Milliseconds retain subminute
information without changing C001.1's rounded ranking-minute convention. Durations
must match the nonnegative difference between instants; offset spellings are
compared as instants. Zero, overnight and long connections are representable, with
no minimum-time, airport-transfer or bookability judgment.

Different independently purchasable components imply a disclosed `self_transfer`
with `{ kind: "separate_bookings" }` evidence, even for the same provider. Cross-
booking protection products are not modeled. Within one component the default is
`unknown` with `{ kind: "unknown" }`. A caller may supply a
`ConnectionProtectionFact` identifying the target trip journey/connection, an
explicit `protected` or `self_transfer` state, and a nonblank source rule reference.
The builder attributes it to that component's provider and provider offer ID.
Duplicate/nonexistent facts and facts targeting separate components are rejected.
An evidence reference records an upstream assertion; it does not independently
verify its truth. Airport change never decides protection. An offer-wide
self-transfer warning is retained even when a particular connection is protected.

### Central derivation and validation

`TripPlanSchema` validates selected sources, components, requested journey paths and
explicit `protectionFacts` (use `[]` when none are known). `createTripOption(plan)`
derives the `travel`, `payment`, `connections` and `warnings` fields. It never searches,
reorders a path, changes a source fact, calls a provider, or mutates its inputs.

`TripTravelSummary` retains each requested journey and its ordered source references,
first departure, final arrival and elapsed milliseconds. Top-level travel fields
include first departure/final arrival, segment count, booking-component count and
**sum of journey elapsed durations**. Destination stays are excluded from that sum.
Derived timestamps use UTC millisecond spelling; the source observations preserve
their original timestamp spellings. A caller can separately calculate the overall
calendar span from the outer endpoints, but must not call it in-transit duration.

`TripOptionSchema` validates the safe source envelope and recomputes all summaries,
connection structure/attribution and warnings. Omitted, duplicated or fabricated
connections, wrong totals/counts/durations, and misleading warning lists are rejected.
Standalone component/summary shapes cannot establish external source consistency;
parse the whole TripOption at the canonical trip boundary. No missing data is used
as proof of protection or feasibility. All new public data survives JSON round trips.

Warnings have a fixed deterministic order: `self_transfer`,
`multiple_booking_components`, `airport_change`, `mixed_payment`,
`unknown_connection_protection`. The builder derives them; callers need not repeat
that logic. `mixed_payment` means different quote kinds across components or a
single genuine cash-and-points quote; taxes on an award alone do not trigger it.
Detailed original offer warnings remain available in the safe source snapshots.
No immigration, baggage, short/long connection or time-zone-based overnight claims
are invented.

### C002.3 dependencies and limits

C002.3 must supply a complete explicit plan using authorized commercial observations,
attach existing C002 fingerprints, and retain evidence for any protection claim.
Binding protection evidence to its actual source observation/segment pair, authoritative
award-payment provenance, and producer-side fingerprint computation/verification remain
C002.3 concerns; the metadata projection patch does not implement those changes.
It still needs request eligibility, bounded candidate generation, feasibility rules
and a policy for stale/partial observations. Mixed-currency totals remain native
obligations until an explicit attributable FX/valuation contract exists. Aggregates
beyond the current 38-digit cash/points bound fail and cannot be clipped.

Source capabilities/terms and award payment mapping must be verified before real
integrations. Route-discovery suggestions, estimated fares and scheduled topology
must stay separate from commercial quotes. C002.2 introduces no RouteDiscoverySource,
source registry, discovery adapter, graph search, persistence redesign or ranking
integration. `searchAll` and the current ranker still operate on FlightOffers.
