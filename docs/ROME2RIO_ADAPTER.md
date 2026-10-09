# C002.3b — experimental Rome2Rio discovery adapter

- **C002.3b-S — Rome2Rio schema-independent scaffold: IMPLEMENTED.** Includes the
  experimental source definition, injectable failure scaffold and discovery record.
- **C002.3b-M — Rome2Rio native mapping: BLOCKED** on authorized genuine tool
  schemas/responses. There is no working native payload mapper or live transport.
- **C002.3c — Bounded Trip Composer: MAY PROCEED independently** using canonical
  RouteCandidate fixtures. It depends on C002.3a canonical discovery contracts,
  not completion of Rome2Rio native mapping. It is not implemented in this patch.

After the 403, the user confirmed that no authorized genuine schema/response fixture
is available and authorized schema-independent scaffolding and mocked-failure tests only.

The intended boundary remains:

`Rome2Rio MCP transport → injected Rome2RioClient → experimental discovery adapter → RouteCandidate`

`Rome2RioDiscoverySource` implements the existing RouteDiscoverySource interface.
The native mapping layer must receive tool payloads separately from MCP/HTTP
envelopes, headers, authentication and session state. Native get-routes/get-schedules
parameters and decoders await actual tool contracts. No guessed request or response
schema is introduced, and synthetic test values are not captured Rome2Rio responses.

Rome2Rio estimate ≠ commercial quote.
Rome2Rio route ≠ FlightOffer.
Rome2Rio schedule ≠ availability guarantee.

## Public discovery evidence

The [official Anthropic connector listing](https://claude.com/marketplace/connectors/rome2rio)
lists `https://chatgpt-app.rome2rio.com/mcp`, `get-routes` and `get-schedules`.
It describes route discovery with estimated prices and schedules when available.
The listing does not supply either tool's input/output schema. Tool names and
consumer connector availability establish no Roamio production, commercial,
transient-use, caching, persistence, display or redistribution permission.

| Tool | Name publicly listed | Input schema obtained | Response schema/fixture obtained |
| --- | --- | --- | --- |
| get-routes | Yes | No | No |
| get-schedules | Yes | No | No |

## Technical review record: rome2rio-connectivity-2026-10-06-v1

- Reviewer: Codex, automated technical assessment in the user-requested C002.3b task.
- Record reviewed at: 2026-10-06T03:32:40Z.
- Baseline: C002.3a commit `bee1707dbd1eeb405922c15df9f73711187e85b7`.
- Scope/version: this v1 connectivity assessment only. No provider-terms review,
  policy approval or legal authorization is asserted.
- Result: experiment metadata may be recorded; live schema discovery is blocked.
  All usage rights remain unknown.

One unauthenticated standard MCP `initialize` POST was sent to the listed endpoint.
It requested protocol `2025-06-18`, empty client capabilities, and identified itself
as `roamio-schema-discovery` version `0.1.0`. Content-Type was `application/json`,
Accept was `application/json, text/event-stream`, and the user agent explicitly
identified this experiment. The request used a 20-second timeout, no credentials,
no cookies and no private traveler data. Initialization follows the
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).

| Observation | Value |
| --- | --- |
| HTTP status | 403 |
| Content type | text/html; charset=UTF-8 |
| Server header | cloudflare |
| Page title | Attention Required! \| Cloudflare |
| MCP session established | No |
| tools/list sent | No |
| tools/call sent | No |

An earlier read-only web-tool open of the endpoint was also unavailable; it did not
yield a protocol response or schema. Protocol probing stopped after the initialize
403. No retry with a different identity, alternate endpoint, browser automation,
scraping or access-control workaround was attempted. No raw block page, response
headers, session state or purported route fixtures were saved in the repository.

## Experimental source definition

`createRome2RioSourceDefinition()` is exported by `@flightbrain/discovery`. It returns
an independent canonical definition with `id: rome2rio`, `accessMethod: mcp`, and
`productionUse.status: experimental`, referencing the technical record above.
All capabilities remain unknown pending actual schema/response validation. Each of
transient use, cache, persist, user display and redistribution independently remains
unknown with null permission-review fields. The technical record grants none of
these rights and is not a substitute for an attributable review of source terms.
No source runner automatically registers or invokes this definition.

## Injectable failure scaffold

The exported `Rome2RioClient` has one schema-independent operation:

```ts
getRoutes(request: RouteDiscoveryRequest, context: RouteDiscoveryContext): Promise<unknown>;
```

This is Roamio's existing canonical intent, not the native MCP input schema. A later
authorized client will translate it using verified input schemas and remove transport
envelopes. The getSchedules signature is intentionally pending genuine route/service
reference semantics; the scaffold never invokes schedule enrichment. No HTTP client,
MCP dependency, network call, retry mechanism or persistence is part of this module.

`new Rome2RioDiscoverySource(client, definition?)` snapshots validated, trusted source
configuration. Source ID and MCP access method must match. Calls require experimental
or approved production status AND an independently allowed transient-use decision.
The default entry has unknown transient rights and returns `error/access_denied`
without calling the client. Constructor injection is a trusted configuration boundary,
not authorization to fabricate an approval. Tests use explicitly synthetic permission
records solely to exercise mock failures. Real auditable usage approval remains blocked.

The source exposes `mappingStatus: blocked_schema_discovery`. Any fulfilled opaque
client payload returns `error/source_unavailable` with no candidates. In particular,
an empty array/object is not assumed to mean successful empty enumeration. The payload
is neither inspected nor serialized. A typed Rome2RioClientError maps only fixed
access-denied, quota, unavailable, timeout or cancellation codes; unknown exceptions
produce `error/internal_error`. Raw error messages and abort reasons never enter DTOs.
Every result passes RouteDiscoveryResultSchema and retains the original request ID.

`startedAt` and `finishedAt` are Roamio local adapter-attempt timestamps. They are
not Rome2Rio server, MCP execution, source observation or schedule timestamps, and
their difference is not transport latency truth. Start is captured once. Every
terminal result uses one completion helper: read the wall clock, compare instants,
and retain the observed completion time unless it precedes the captured start, in
which case use that start instant. Clock rollback may collapse the interval to zero
for canonical safety; no elapsed time is inferred or fabricated. The canonical
`finishedAt >= startedAt` validator is unchanged.

The request is validated and cloned; the client receives another request-scoped copy
so it cannot mutate caller data or result provenance. Private addresses/coordinates
may exist only in that invocation's input. Tests prove they and synthetic credential
markers do not enter failure-result JSON, even if the mock echoes them. This is
failure-output isolation, NOT a completed native privacy/identifier mapper. Explicit
request-endpoint references and public-ID allowlists await the real source payload.

Already-aborted calls return `error/cancelled`; elapsed deadlines return
`timeout/deadline_exceeded` without a client call. Deadlines use canonical instant
validation, including offset equivalence and millisecond precision. Invalid instants
or delays exceeding the timer's signed-32-bit millisecond range are unsupported.
With a future deadline, the source stops waiting and aborts its child signal at the
deadline; caller cancellation also stops waiting. Timers/listeners are cleaned up,
and late client rejections remain handled. This bounds the wait for an asynchronous
client; it cannot terminate an underlying operation that ignores abort or preempt
synchronous blocking code. A null deadline adds no implicit timeout.

No candidates can yet be accepted, so the scaffold emits neither success nor partial.
Preserving accepted routes after schedule-enrichment failure remains native-mapping
work. No schedules, prices, evidence, protection claims or commercial objects are
generated, and no unknown payload is relabeled as canonical discovery data.

## Required artifacts to resume C002.3b-M

Obtain a legitimate tools/list response or authoritative input/output schemas for
the two tools, plus genuinely sourced sanitized route and schedule responses. Record
their origin and capture/schema version. Remove credentials and private traveler
values before retaining any fixture, under applicable retention permission. Include
examples establishing mode vocabulary, ordering, location semantics, identifier
meaning, timestamp/time-zone semantics, numeric precision and price basis.

The remaining implementation and fixture regressions belong to C002.3b-M:

- Implement the injected client's translation from verified tool schemas and define
  schedule enrichment from actual source references. Keep HTTP/MCP internals out of
  canonical mapping. No generic MCP framework.
- Map actual route and schedule facts, retaining unknowns and preserving exact
  chronology. Unknown schedules must remain null, and connectivity must never
  establish protected ticketing or commercial availability.
- Preserve price text/precision; use exact Money only for lossless amounts inside
  EstimatedPrice, with unknown basis unless the source establishes it. Omit unsafe
  estimates. Never produce FlightOffer, PaymentQuote, BookingComponent or TripOption.
- Keep private addresses/coordinates request-scoped, using an explicit endpoint
  reference where necessary. Audit actual source echoes before defining that mapping;
  public source hubs must remain usable. The existing LocationRef is unchanged here.
- Allowlist verified public identifier fields. Omit/null unsafe IDs or authenticated
  URLs; do not use a speculative universal secret-detection regex.
- Bind fresh evidence to each accepted source/candidate/leg occurrence. Complete
  enrichment before publishing the observation; preserve previously accepted route
  observations if enrichment fails. Do not mutate published evidence targets.
- Add true empty-success and partial-enrichment mapping, preserving the existing
  scaffold's fixed failure diagnostics. Verify cancellation behavior for the actual
  client; stopping the caller's wait does not prove remote execution was cancelled.
- Establish attributable, action-specific permissions before real usage, persistence
  or display. This technical record does not complete the rights-review P1.
- Add genuine sanitized fixtures and tests for all requested mapping/security/type
  boundaries, including secret markers, private endpoints, duplicate-looking routes,
  offsets, milliseconds, immutability and failed schedule enrichment. Unit tests must
  remain offline. Current definition/failure tests make no native-mapping coverage claim.

These requirements remain unresolved in C002.3b-M; they do not block C002.3c and
are not moved to it. The bounded composer still owns verification-job selection, budgets,
request eligibility and connection feasibility. No graph search, commercial searches,
FX, ranking, booking, UI, persistence or GTFS integration is included.
