# Data Source Matrix

| Source | Role | Access reality | MVP stance |
|---|---|---|---|
| Duffel | cash shopping / booking | developer API, airline offers, offer expiry/revalidation semantics | strong first production candidate |
| Skyscanner | metasearch live prices | partner API/application required | add after approval |
| Expedia Rapid Flights | shopping/booking | Expedia partner onboarding | add after approval |
| Travelport | GDS/NDC flight search | commercial access/onboarding | later breadth source |
| Amadeus Self-Service / enterprise | shopping | useful for development; inventory/commercial constraints must be validated | prototype/secondary source |
| Seats.aero | award availability | commercial agreement required for commercial live search | award phase only after agreement |
| Google Flights | benchmark/discovery | public docs describe Google onboarding airlines/OTAs; not a general consumer metasearch API | do not build dependency on scraping it |
| FlightAware AeroAPI | live operational tracking | commercial flight tracking API | separate tracking service/phase |

Always confirm current commercial terms, pricing, quotas, attribution rules and permitted caching before production use.


## Proposed discovery sources (unverified; future work)

Rome2Rio is a candidate for C002.3b experimentation as a route-discovery source,
not an authoritative fare source. Current connector tools, access rights, commercial
terms, quotas and retention/redistribution permissions must be verified before use.
No adapter, production authorization or coverage claim is implied by this listing.
Route suggestions and estimated prices must be kept distinct from provider quotes.
A future source registry can evaluate MCP connectors, public APIs, GTFS/open transit,
airport/reference data and other modes with per-source provenance and permissions.
