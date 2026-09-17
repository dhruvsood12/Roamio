# FlightBrain

FlightBrain is a flight intelligence/metasearch platform designed to compare authorized cash-fare, award-travel, and eventually live-flight sources through a common canonical model.

## Product principle

Never make an LLM, scraper, or one upstream provider the source of truth. Offers are provider observations with provenance, freshness, expiry, and confidence.

## MVP

1. Search one-way/round-trip cash fares through one production provider plus a mock provider.
2. Normalize all offers into one schema.
3. Deduplicate equivalent itineraries while preserving source-specific bookable offers.
4. Rank by transparent dimensions (price, duration, stops, inconvenience, booking quality).
5. Render "Cheapest", "Fastest", and "Best trade-off" without hiding the underlying metrics.
6. Revalidate the selected offer before redirect/booking.

## Non-goals for V1

- "Scrape every website"
- Circumvent bot protection/CAPTCHAs/access controls
- Direct ticketing across every airline
- Award travel across every loyalty program
- Live aircraft tracking inside the fare-search service
- LLM-generated prices, schedules, or availability

## Run philosophy

Use Codex in small, contract-bound tasks. Read `AGENTS.md` first, then `docs/MASTER_PLAN.md` and `docs/ARCHITECTURE.md`.
