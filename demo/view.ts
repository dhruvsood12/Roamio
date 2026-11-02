import type { LocationRef, RouteCandidate, RouteEvidence } from "@flightbrain/domain";
import type { VerificationJob } from "@flightbrain/composer";
import { BUDGETS, budgetRegressionDemo, coreContractsDemo, displayMoney, milestoneRows, plannerDemo, SCENARIOS,
  type Budget, type PlannerDemo, type Scenario } from "./model";

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
const e = escapeHtml;
const json = (value: unknown) => `<pre>${e(JSON.stringify(value, null, 2))}</pre>`;
const tag = (label: string, style = "") => `<span class="tag ${style}">${e(label)}</span>`;
const location = (value: LocationRef): string => value.kind === "airport" ? value.iataCode
  : value.kind === "city" || value.kind === "metro_area" ? value.name : value.kind;
const route = (airports: string[]) => airports.map(e).join('<span class="arrow">→</span>');
const stateClass = (status: string) => status === "IMPLEMENTED" ? "green" : status === "BLOCKED" ? "amber" : status.startsWith("SIMULATED") ? "blue" : "muted";

function evidence(facts: RouteEvidence[], indices = facts.map((_, i) => i)): string {
  return `<ol class="evidence-list">${indices.map(i => {
    const fact = facts[i];
    return `<li><b>Evidence ${i} · ${e(fact.factType)}</b><span>${e(fact.sourceId)} · ${e(fact.level)} · ${fact.target.kind === "leg" ? `leg ${fact.target.legIndex}` : "candidate"}</span>
      <span>Observed: ${e(fact.observedAt ?? "unknown")} · expires: ${e(fact.expiresAt ?? "unknown")}</span>
      <span>Source reference: ${fact.sourceReference === null ? "unknown" : e(JSON.stringify(fact.sourceReference))}</span></li>`;
  }).join("")}</ol>`;
}

function candidateCard(candidate: RouteCandidate | null, index: number, model: PlannerDemo): string {
  const decision = model.result.decisions[index];
  const status = decision?.status === "eligible" ? "eligible" : decision?.status === "skipped" ? decision.reason : "unexamined";
  if (!candidate) return `<article class="candidate"><span class="eyebrow">Candidate ${index + 1}</span><h3>Malformed fixture</h3>${tag(status, "amber")}<p>Validation rejected the input. Its raw payload is withheld.</p></article>`;
  const unknowns = candidate.legs.reduce((n, leg) => n + [leg.departureAt, leg.arrivalAt, leg.operator, leg.serviceRef].filter(v => v === null).length, 0);
  return `<article class="candidate" id="candidate-${index}">
    <div class="card-top"><span class="eyebrow">Candidate ${index + 1}</span>${tag(status, status === "eligible" ? "green" : "amber")}</div>
    <h3>${route([location(candidate.legs[0].origin), ...candidate.legs.map(leg => location(leg.destination))])}</h3>
    <div class="source-id">Occurrence ${e(candidate.id)} · input #${index}</div>
    <div class="source-id">${e(candidate.source.sourceId)} / ${e(candidate.source.kind)}</div>
    <ol class="leg-list">${candidate.legs.map(leg => `<li><span>${e(location(leg.origin))} → ${e(location(leg.destination))}</span><small>${e(leg.mode)} · ${e(leg.role)} · schedule ${e(leg.scheduleState)}</small>
      <small>Departure ${e(leg.departureAt ?? "unknown")}<br>Arrival ${e(leg.arrivalAt ?? "unknown")}</small></li>`).join("")}</ol>
    <p class="micro">${unknowns} unresolved time / operator / service fields<br>Estimate: ${candidate.estimatedPrice ? `${e(displayMoney(candidate.estimatedPrice.amount))} (${e(candidate.estimatedPrice.basis)})` : "unknown"}
      · duration: ${candidate.estimatedDurationMinutes === null ? "unknown" : `${candidate.estimatedDurationMinutes} min`}</p>
    <details><summary>${candidate.evidence.length} evidence records · ${e([...new Set(candidate.evidence.map(f => f.level))].join(", "))}</summary>${evidence(candidate.evidence)}</details>
  </article>`;
}

function departureLabel(job: VerificationJob): string {
  const departure = job.requestIntent.departure;
  if (departure.kind === "after_verified_arrival") return `Unresolved · after candidate ${departure.candidateIndex + 1}, leg ${departure.precedingLegIndex}`;
  if (departure.intent.kind === "unspecified") return "Unresolved · request date unspecified";
  if (departure.intent.kind === "date") return departure.intent.date;
  return `${departure.intent.startAt} – ${departure.intent.endAt}`;
}

function bindings(job: VerificationJob, model: PlannerDemo): string {
  return `<div class="bindings">${job.sourceBindings.map(binding => {
    const decision = model.result.decisions[binding.candidateIndex];
    if (decision?.status !== "eligible") throw new Error("Validated job lost its source binding");
    return `<div class="binding"><a href="#candidate-${binding.candidateIndex}">Candidate ${binding.candidateIndex + 1} · occurrence ${e(decision.candidate.id)}</a>
      <span>Original legs ${binding.fromLegIndex}..${binding.toLegIndex} · evidence [${binding.routeEvidenceIndices.join(", ")}]</span>
      <span>${e(decision.candidate.source.sourceId)}</span><details><summary>Inspect bound facts</summary>${evidence(decision.candidate.evidence, binding.routeEvidenceIndices)}</details></div>`;
  }).join("")}</div>`;
}

function planner(model: PlannerDemo): string {
  const result = model.result;
  const skipped = result.decisions.filter(d => d.status === "skipped");
  const countReason = (reasons: string[]) => skipped.filter(d => d.status === "skipped" && reasons.includes(d.reason)).length;
  const regression = budgetRegressionDemo();
  const rescued = regression.jobs.find(job => job.requestIntent.airports.join("/") === "LAX/SFO");
  return `<section id="planner" class="section">
    <div class="section-heading"><div><span class="eyebrow">01 / Verification planner · implemented</span><h2>Discover broadly. Verify selectively.</h2></div>${tag("Real planner output", "green")}</div>
    <form class="controls" action="/" method="get">
      <label>Scenario<select name="scenario">${Object.entries(SCENARIOS).map(([key, label]) => `<option value="${key}" ${key === model.scenario ? "selected" : ""}>${e(label)}</option>`).join("")}</select></label>
      <label>Budget preset<select name="budget">${Object.entries(BUDGETS).map(([key, preset]) => `<option value="${key}" ${key === model.budget ? "selected" : ""}>${preset.label} · ${preset.maxCandidates} candidates / ${preset.maxLegsPerCandidate} legs / ${preset.maxJobs} jobs</option>`).join("")}</select></label>
      <button type="submit">Run planner <span aria-hidden="true">↗</span></button>
    </form>
    <div class="search-intent"><span class="eyebrow">Search intent · synthetic</span><strong>${route([location(model.request.origin), location(model.request.destination)])}</strong>
      <span>${model.request.departure.kind === "date" ? `Request date ${e(model.request.departure.date)}` : "Departure unresolved"} · passenger context unknown</span></div>
    <div class="flow-stem" aria-hidden="true">↓</div>
    <div class="label-row"><h3>Route discovery candidates</h3>${tag("SIMULATED WITH CANONICAL FIXTURES", "blue")}</div>
    <p class="explanation">Discovery candidates tell Roamio what may be worth investigating. They are not bookable fares. <b>RouteCandidate ≠ FlightOffer.</b></p>
    <div class="candidate-grid">${model.candidates.map((c, i) => candidateCard(c, i, model)).join("")}</div>
    ${model.scenario === "multimodal" ? `<div class="notice amber"><b>Both movements remain visible.</b> Rail travel and unresolved city endpoints are outside the current flight planner. The flight leg could require future airport resolution and commercial verification; the planner does not extract it by dropping the ground leg. This request stops at <code>unsupported_request_location</code>.</div>` : ""}
    <div class="flow-stem" aria-hidden="true">↓</div>
    <div class="metrics">
      <div><span>Admitted source spans</span><strong data-testid="span-count">${model.occurrenceSpans}</strong><small>Occurrence + original leg range</small></div>
      <div><span>Exact intent grouping</span><strong data-testid="intent-count">${model.uniqueIntents}</strong><small>Unique canonical verification intents</small></div>
      <div class="selected-metric"><span>After job budget</span><strong data-testid="job-count">${result.jobs.length}</strong><small>Selected of ${model.policy.maxJobs} available slots</small></div>
      <div><span>Omitted by job limit</span><strong data-testid="deferred-count">${model.deferredIntents}</strong><small>Within admitted candidates</small></div>
    </div>
    <p class="explanation">An <b>occurrence span</b> records why an investigation was requested. A <b>verification intent</b> describes work that may eventually become a provider request. Dates, passenger eligibility and provider capabilities still need resolution. These counts are <b>not actual API calls</b>.</p>
    <div class="counts">${tag(`${result.decisions.filter(d => d.status === "eligible").length} eligible candidates`, "green")}
      ${tag(`${result.unexaminedCandidateCount} unexamined`)} ${tag(`${countReason(["unsupported_movement"])} unsupported`)}
      ${tag(`${countReason(["invalid_candidate"])} malformed`)} ${tag(`${countReason(["stale_candidate"])} stale`)} ${tag(`${skipped.length} total skipped`)}</div>
    <p class="micro">Canonical diagnostics: <code>${e(result.diagnostics.join(", ") || "none")}</code> · freshness evaluated at fixed fixture instant ${e(model.policy.asOf)}.</p>
    ${model.shared.map(job => `<div class="group-highlight" data-testid="shared-intent"><div><span class="eyebrow">Shared investigation · one job slot</span><h3>${route(job.requestIntent.airports)}</h3><p>Two route ideas can justify one provider query without losing provenance.</p><small>${e(departureLabel(job))} · ${job.sourceBindings.length} source bindings</small></div>${bindings(job, model)}</div>`).join("")}
    <div class="label-row"><h3>Bounded investigation set</h3><span class="micro">${result.jobs.length} intents · ${result.jobs.reduce((n, j) => n + j.sourceBindings.length, 0)} preserved bindings</span></div>
    <div class="job-list">${result.jobs.map(job => `<details class="job"><summary><span class="job-number">${String(job.id + 1).padStart(2, "0")}</span><b>${route(job.requestIntent.airports)}</b><span class="departure">${e(departureLabel(job))}</span>${tag(`${job.sourceBindings.length} binding${job.sourceBindings.length === 1 ? "" : "s"}`, job.sourceBindings.length > 1 ? "green" : "")}</summary>
      ${bindings(job, model)}<p class="micro">Passenger context: ${job.requestIntent.passengers === null ? "unknown" : e(JSON.stringify(job.requestIntent.passengers))}. Route paths are investigation constraints, not a claim of provider via-airport support.</p><details><summary>Canonical request intent</summary>${json(job.requestIntent)}</details></details>`).join("") || '<div class="empty">No jobs admitted. Review the canonical diagnostics and candidate decisions above.</div>'}</div>
    <div class="note-grid"><div class="note"><h4>Unknown means unknown</h4><p>Later spans retain their candidate occurrence and preceding-leg dependency. The planner records the dependency rather than guessing a date. Different unresolved arrivals stay separate.</p></div>
      <div class="note"><h4>Why the budget matters</h4><p>Roamio cannot query every conceivable route/provider combination. In the separate two-route regression, ${regression.jobs.reduce((n,j) => n+j.sourceBindings.length,0)} bindings fit into ${regression.jobs.length} unique slots. ${rescued ? "LAX → SFO stays in the investigation set." : "LAX → SFO was not admitted."} Duplicate DEL → NRT work costs one slot.</p><details><summary>Actual eight-slot regression output</summary>${json(regression.jobs.map(j => ({ route: j.requestIntent.airports, sourceBindings: j.sourceBindings })))}</details></div></div>
    <div class="pipeline-break"><span aria-hidden="true">↓</span><b>Provider execution — NOT YET BUILT</b><span>Trusted execution validation, commercial searches and live offers stop here.</span></div>
  </section>`;
}

function contracts(): string {
  const core = coreContractsDemo();
  const same = core.offers[0].fingerprint !== null && core.offers[0].fingerprint === core.offers[1].fingerprint;
  return `<section id="contracts" class="section"><div class="section-heading"><div><span class="eyebrow">02 / Core contracts · implemented</span><h2>Identity, exact value, explicit boundaries.</h2></div>${tag("SYNTHETIC COMMERCIAL FIXTURES", "blue")}</div>
    <p class="explanation">These independent examples exercise existing contracts. They are not provider results generated from the planner above.</p>
    <div class="contract-grid"><article class="panel fingerprint"><span class="eyebrow">Schedule Fingerprint V1</span><h3>Same flight. Separate offers.</h3><p>Price and marketing identity do not change a known physical schedule.</p>
      ${core.offers.map(({ offer, fingerprint }) => { const segment = offer.journeys[0].segments[0]; return `<div class="offer"><div><b>${e(offer.id)}</b><span>${e(segment.marketingCarrier)} ${e(segment.marketingFlightNumber)} marketed · ${e(segment.operatingCarrier)} ${e(segment.operatingFlightNumber ?? "unknown")} operated</span></div><strong>${e(displayMoney(offer.totalPrice))}</strong><code>${fingerprint ? `${e(fingerprint.slice(0, 32))}…` : "fingerprint = null"}</code></div>`; }).join("")}
      <div class="counts">${tag(same ? "Known schedules match" : "Schedules differ", same ? "green" : "amber")}${tag(`${core.groups.length} groups · ${core.offers.length} offers preserved`)}</div>
      <p class="micro">Missing operating identity never becomes a guessed shared identity.</p><details><summary>Full computed fingerprints</summary>${json(core.offers.map(v => ({ id: v.offer.id, fingerprint: v.fingerprint })))}</details></article>
    <article class="panel money"><span class="eyebrow">Exact Money</span><h3>Every minor unit accounted for.</h3><div class="equation"><span>${e(displayMoney(core.money.a))}</span><span>+ ${e(displayMoney(core.money.b))}</span><strong>= ${e(displayMoney(core.money.total))}</strong></div>${json(core.money.total)}
      <h4>Different currencies stay separate</h4><p>${core.money.separate.cashByCurrency.map(displayMoney).map(e).join(" + ")}</p>${tag(core.money.mixedRejected ? "Mixed-currency addition rejected" : "Unexpected arithmetic result", "amber")}<p class="micro">No currency conversion. No floating-point money arithmetic.</p></article></div>
    <article class="panel trip"><div class="label-row"><div><span class="eyebrow">TripOption contract / explicit plan builder</span><h3>Three bookings. One proposed journey.</h3></div>${tag("SYNTHETIC VERIFIED COMMERCIAL FIXTURES", "blue")}</div>
      <p>“Verified” describes the synthetic fixture role only; no provider was contacted. This demonstrates the TripOption contract. Roamio does not yet automatically turn verification jobs into these offers.</p>
      <div class="trip-components">${core.trip.bookingComponents.map((component, i) => {
        const segments = core.trip.sourceOffers[component.sourceOfferIndex].journeys.flatMap(j => j.segments);
        const payment = component.payment;
        return `<div><span class="eyebrow">Booking component ${i + 1}</span><h3>${route([segments[0].origin, ...segments.map(s => s.destination)])}</h3>${tag(payment.kind)}<p>${payment.kind === "cash" ? e(displayMoney(payment.amount)) : `${e(payment.points)} points · ${e(payment.program.id)}`}</p>
          <small>${e(component.provider)} · ${e(component.providerOfferId)}</small></div>`;
      }).join("")}</div>
      <div class="connections">${core.trip.connections.map(connection => `<div>${tag(connection.protection, "amber")}<b>${e(connection.arrivalAirport)} → ${e(connection.departureAirport)}</b><span>Booking ${connection.fromComponentIndex + 1} → ${connection.toComponentIndex + 1} · ${connection.durationMilliseconds / 3_600_000}h gap · ${e(connection.evidence.kind)}</span></div>`).join("")}</div>
      <div class="trip-totals"><div><span>Exact cash obligations, by currency</span><strong>${core.trip.payment.cashByCurrency.map(displayMoney).map(e).join(" + ")}</strong></div><div><span>Points, by program</span><strong>${core.trip.payment.pointsByProgram.map(p => `${e(p.points)} ${e(p.program.id)}`).join(" + ")}</strong></div></div>
      <div class="counts">${core.trip.warnings.map(w => tag(w, "amber")).join("")}</div><p class="micro">Separate bookings carry self-transfer risk. A scheduled gap does not prove transfer feasibility.</p>
      <details><summary>Validated TripOption: safe source snapshots and derived totals</summary>${json(core.trip)}</details>
      <div class="pipeline-break"><b>Automatic TripOption composition — NOT YET BUILT</b></div>
    </article></section>`;
}

export function renderDemo(markdown: string, scenarioInput: string | null, budgetInput: string | null): string {
  const scenario: Scenario = scenarioInput && Object.hasOwn(SCENARIOS, scenarioInput) ? scenarioInput as Scenario : "routes";
  const budget: Budget = budgetInput && Object.hasOwn(BUDGETS, budgetInput) ? budgetInput as Budget : "generous";
  const model = plannerDemo(scenario, budget);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Roamio Core Intelligence Demo</title><link rel="stylesheet" href="/styles.css"><link rel="icon" href="data:,"></head><body>
    <header><a class="brand" href="/"><span>r.</span>roamio<small>CORE LAB</small></a><nav aria-label="Page sections"><a href="#planner">Planner</a><a href="#contracts">Core contracts</a><a href="#state">Engineering state</a></nav>${tag("LOCAL ONLY", "green")}</header>
    <main><div class="hero"><div><span class="eyebrow">Discover broadly · verify selectively · preserve why</span><h1>Roamio Core<br>Intelligence Demo</h1><p>Route discovery → bounded verification planning → commercial composition contracts</p></div><div class="hero-status">${tag("DEVELOPER DEMO")}${tag("SYNTHETIC CANONICAL DATA", "blue")}${tag("NO LIVE FARES", "amber")}<p>Working core logic.<br>Every unfinished boundary visible.</p></div></div>
      ${planner(model)}${contracts()}
      <section id="state" class="section"><div class="section-heading"><div><span class="eyebrow">03 / Current engineering state</span><h2>What works today. What comes next.</h2></div>${tag("From docs/CURRENT_STATE.md")}</div>
        <div class="status-list">${milestoneRows(markdown).map((row, i) => `<div><span class="job-number">${String(i + 1).padStart(2, "0")}</span><b>${e(row.name)}</b>${tag(row.status, stateClass(row.status))}<span>${e(row.detail)}</span></div>`).join("")}</div>
        <details class="panel"><summary>Read the current-state source</summary><pre>${e(markdown)}</pre></details>
      </section>
      <footer><b>No live flight prices · No live availability · No booking</b><p>No Rome2Rio native mapping · No provider execution · No production ranking</p><small>Canonical fixtures + real domain functions. Everything runs on this computer.</small></footer>
    </main></body></html>`;
}
