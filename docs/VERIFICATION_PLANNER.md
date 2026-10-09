# C002.3c — bounded verification-job planning

Status: **planning implemented for review**. Per the user-directed split, provider
execution and TripOption construction belong to a separate follow-up. C002.3c as a
whole is not complete. Rome2Rio native mapping remains blocked independently.

`@flightbrain/composer` consumes canonical `RouteCandidate[]` and a canonical
`RouteDiscoveryRequest`. It imports domain contracts only, with no discovery source,
Rome2Rio client, FlightProvider, orchestrator, ranking, network or persistence dependency.
Synthetic canonical fixtures exercise the same boundary as any future authorized source.

## Pure planning boundary

```ts
planVerificationJobs(request, candidates, policy): VerificationPlan
```

Policy is explicit: `asOf`, `maxCandidateAgeMs`, `maxCandidates`,
`maxLegsPerCandidate`, and `maxJobs`. Counts are nonnegative safe integers. There
are no defaults or wall-clock reads. Zero budgets are valid. Current limits allow
at most 1,000 examined candidates, 32 legs per candidate and 10,000 jobs per plan.
The job budget counts distinct canonical verification intents, not source bindings.
It does not by itself cap commercial API calls or network concurrency: unresolved
dates, windows and provider capabilities still require trusted execution planning.

The input is one finite, ordered snapshot. Candidate examination stops at
`maxCandidates`; the unexamined tail is not read. Overlong routes are skipped before
walking their canonical refinements. Canonical validation remains proportional to
the supplied candidate/evidence size; these are job/work-selection limits, not a
general untrusted-payload byte limit. Malformed candidates receive a fixed reason
without discarding other candidates. Malformed requests/policies fail validation.

Each considered candidate retains its original input index. Eligible candidates
retain independently cloned canonical snapshots; skipped decisions contain only an
index and fixed reason. Inputs are never mutated. Duplicate paths, native IDs or
candidate IDs do not merge observations. Exact-equivalent verification intents may
share a job while retaining all source bindings. Indexes and job IDs are local to
one plan, not durable route identities or Schedule Fingerprint V1 hashes.

Planning the same snapshot with the same policy is deterministic. Separate calls
are independent snapshots, not progressive appends, retries or replacements.
Planning performs no side effects; its IDs are not execution-idempotency keys.
The execution follow-up must define an invocation/replay ledger and a cumulative
budget before consuming plans progressively. Repeated planning does not grant a
fresh allowance for actual provider calls.

## Eligibility and unknown facts

This initial planner handles explicit airport-to-airport flight travel. It neither
resolves metropolitan/private locations nor drops ground/transfer legs to create a
flight-only trip. Unsupported request endpoints return zero jobs without copying
private locations into output. Requests excluding flight also produce zero jobs.
Unsupported candidates have explicit skip reasons rather than silent truncation.

Eligible candidates must match request ID and endpoints, have contiguous flight
legs with travel roles, stay within the request's stop limit, and contain no repeated
airport. Spatial gaps, cycles, unsupported modes/roles and excessive legs are skipped.
Airport codes retain the canonical syntax semantics; no airport registry is invented.

Freshness is a planning policy, not a change to valid discovery observations:

- Candidate receipt time cannot be after `asOf` or older than `maxCandidateAgeMs`.
  Equality at the age limit is accepted; comparisons retain milliseconds and offsets.
- Every leg needs at least one source-bound `route_exists` assertion whose known
  expiry is strictly after `asOf` and whose known observation time is not future.
- Null evidence times remain unknown. Recent receipt is not proof of fresh source
  facts, and usable route evidence does not establish availability or bookability.
- Other evidence, including expired estimates, remains unchanged in snapshots.
  Schedules, prices and durations do not rank candidates or supply commercial facts.

This checks discovery investigation eligibility only. Commercial passenger, cabin,
market, date, fare and payment eligibility require the follow-up's commercial intent
and observations. Discovery party count must not become an invented adult count.
Source permissions, private-field projection and public identifier selection remain
the source/caller boundary's responsibility; receiving a candidate grants no rights.

## Jobs and bounded ordering

A job contains `requestIntent` and nonempty `sourceBindings[]`. Each binding retains
`candidateIndex`, inclusive `fromLegIndex`/`toLegIndex`, and `routeEvidenceIndices`.
The intent contains the complete ordered `airports` path, `departure` state and the
request's existing nullable `passengers` context. Party count remains discovery
intent; it does not supply passenger ages or commercial eligibility.

For each candidate the whole route comes first, followed by longer subroutes and
leftmost ties. Span enumeration is lazy and round-robin across candidates in input
order. First encounter of an exact intent determines job order. Later equivalent
spans append bindings in that same deterministic encounter order. A Map provides
key lookup; the output array is ordered explicitly by first admission.

Grouping precedes charging a job-budget slot. Enumeration continues after the
budget fills so admitted intents retain all their supporting bindings, including
ones encountered after an omitted intent. At most `maxJobs` intents are retained;
candidate/leg limits bound enumeration to at most 1,000 × 32 × 33 / 2 source spans.
`job_limit` means at least one distinct intent was omitted, not that equivalent
bindings consumed separate jobs. This is exploration order, not a ranking score.

The synthetic routes DEL–SFO, DEL–NRT–LAX–SFO, DEL–DOH–SFO and DEL–NRT–SFO produce
1 + 6 + 3 + 3 = **13 occurrence spans and 12 unique intents** with sufficient budget.
DEL–NRT from the second and fourth candidates shares the same request departure
intent and passenger context, so one job retains both bindings. An unspecified
request date refers to the same request-level intent in this plan. Arrival-dependent
suffixes retain their own occurrence dependencies; a path match does not erase them.
The first four jobs investigate each complete route. Subroutes let a later composer investigate
different booking boundaries. They are not instructions to discard purchased legs;
future composition must preserve all selected commercial offer segments.

Exact equivalence compares every field of the strict canonical request-intent
schema. Schema parsing fixes object-key order before JSON key construction; array
order and timestamp spellings are retained. No fuzzy location/date equivalence is
used. Different paths, dates/windows, passenger counts or dependency identities
remain separate. Grouping is local to one plan/request; discovery allowed-mode and
stop constraints are applied during admissibility, with exact flight paths retained
in each intent. No new cabin, fare, market or passenger-age fields are invented.
This groups investigation work, not candidates, offers or physical-flight identities.

Departure is explicit and may remain unresolved:

- A span starting at source leg zero copies the request's date/window/unspecified
  intent. It does not turn a discovery schedule into an authoritative departure date.
- A later span carries `after_verified_arrival` with its candidate occurrence and
  original preceding-leg index. Distinct occurrences' unknown arrivals are not equal
  dependencies. It needs commercial prefix verification and date/connection resolution.
  No day rollover, duration, minimum connection time or feasible transfer is inferred.

These descriptors cannot be submitted directly to FlightProvider.search. A route
path is an investigation/filter target, not a claim that an API supports via-airport
parameters. The follow-up must translate supported commercial requests explicitly.

Each binding's `routeEvidenceIndices` address usable per-leg route assertions in its
original candidate snapshot. A span beginning at source leg two keeps that source index; it
does not relabel evidence as leg zero or transfer evidence to another source. Price,
schedule and candidate-level facts are not promoted to subroute fare/protection facts.
The exported result schema checks each binding against actual source-leg endpoints,
original order, adjacency, the complete intent path and evidence indexes/targets.
Eligible snapshots must be connected flight paths, including at the result boundary;
the general RouteCandidate contract still permits discontinuous hints. Duplicate
spans or split exact-equivalent jobs are rejected. Validation never retargets evidence.

`candidate_limit` and `job_limit` report incomplete exploration independently.
Skipped reasons remain visible, and unsupported requests report why nothing was
planned. Exhausting this finite snapshot is not exhaustive source/market coverage.

## Execution/composition follow-up

The separate follow-up owns complete commercial request eligibility and date
resolution; authorized provider calls and cost/deadline/cancellation accounting;
progressive observation/replay semantics; commercial freshness; connection and
airport-transfer feasibility; offer-bound protection/award evidence; existing V1
fingerprint computation; and construction of complete canonical TripOptions.
Discovery schedules/estimates never become quotes, availability or protection.
Money, existing trip contracts, ranking, providers and Schedule Fingerprint V1
remain unchanged by this planning change.

A required future gate, conceptually `validatePlanForExecution(plan, trustedContext)`,
must run before provider calls. It must bind request dates and passenger intent to
the active trusted request, recheck freshness/current policy, and establish coverage,
truncation, replay and cumulative cost semantics against trusted context. A standalone
schema proves structural/internal consistency, not current execution eligibility or
authenticity of supplied snapshots. No such execution gate or provider calls are
implemented here.
