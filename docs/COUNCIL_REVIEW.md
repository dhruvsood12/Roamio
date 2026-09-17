# Adversarial LLM Council Review

This is a structured multi-role critique, not a claim that independent external models were executed.

## 1. Travel distribution architect
**Attack:** "Every airline/every site" is a false requirement. GDS/NDC/aggregators overlap, diverge, cache differently, and expose different negotiated/private fares. Coverage is probabilistic.

**Required change:** model coverage explicitly. A search response must contain `sourcesAttempted`, `sourcesSucceeded`, `sourcesTimedOut`, freshness, and market/currency context.

## 2. Scraping / platform-risk reviewer
**Attack:** a product whose core advantage depends on bypassing anti-bot measures will be fragile, expensive, operationally hostile, and potentially contractually prohibited.

**Required change:** official/partner APIs and authorized feeds first. Web extraction is source-specific and only when permitted. No access-control bypass architecture.

## 3. Backend/distributed-systems reviewer
**Attack:** naive fan-out to 10 providers multiplies latency, cost, rate-limit risk, and failure modes. Flexible dates × nearby airports can explode into hundreds of upstream searches.

**Required change:** query planner, provider budget, deadlines, cancellation, caching, progressive results, circuit breakers, and per-provider health metrics.

## 4. Data-quality reviewer
**Attack:** comparing prices is deceptively hard. Baggage, fare brand, refundability, currency, married segments, ancillaries, residency/market pricing, and stale offers can make "cheapest" wrong.

**Required change:** canonical offer semantics, explicit unknown fields, market context, price timestamp, revalidation and total-trip-cost calculations.

## 5. Product/UX reviewer
**Attack:** hundreds of filters and scores recreate Kayak clutter. "Best" can feel manipulative if opaque.

**Required change:** default to 3-5 understandable choices and show why. Preserve an advanced mode. Explain trade-offs in plain language.

## 6. Award-travel reviewer
**Attack:** points comparisons become misleading when transfer bonuses, taxes, mixed cabins, saver inventory, cancellation rules, and point valuations vary.

**Required change:** user-controlled valuations, program/source attribution, mixed-cabin percentage, transfer assumptions, and no universal cents-per-point truth.

## 7. Ranking/data-science reviewer
**Attack:** one weighted score creates arbitrary outcomes and is easy to game.

**Required change:** Pareto frontier first, then transparent preference-aware ranking over normalized dimensions. Keep deterministic baselines before ML personalization.

## 8. Security/privacy reviewer
**Attack:** loyalty credentials, passport data, traveler profiles, and booking payment flows massively raise scope and liability.

**Required change:** V1 stores minimal profile data. Do not store airline passwords. OAuth where available. Delay booking/payment until product-market fit warrants PCI and support burden.

## 9. SRE/cost reviewer
**Attack:** unrestricted refreshes and alerting can create a runaway API bill.

**Required change:** quota ledger, per-search cost ceiling, request coalescing, cache policy by provider, alert backoff, and cost telemetry from day one.

## 10. Business reviewer
**Attack:** "more results" is not a moat. Incumbents have massive distribution relationships.

**Required change:** differentiation must be decision quality: cross-source provenance, nearby-airport/date intelligence, cash-vs-points comparison, cabin arbitrage, and explainable trade-offs.

## Council consensus
Proceed **only** with an API-first metasearch/intelligence product. Treat broad coverage as measured telemetry, not a promise. Defer booking and live tracking. Build trust/revalidation before breadth.
