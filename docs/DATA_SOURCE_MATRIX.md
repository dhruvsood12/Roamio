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
