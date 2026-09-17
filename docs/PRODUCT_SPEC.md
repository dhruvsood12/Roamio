# Product Spec — MVP

## Primary user
A traveler who cares about more than sticker price and wants a fast explanation of the real trade-offs.

## Core flow
1. Enter origin/destination/date(s)/passengers/cabin.
2. Optional: date flexibility, nearby airports, max stops.
3. Receive progressive results.
4. See three primary lenses: Cheapest, Fastest, Best trade-off.
5. Expand any itinerary for source offers, baggage, fare conditions and provenance.
6. Select an offer.
7. Revalidate.
8. Redirect to provider/airline or proceed to a later booking flow.

## Trust UI
Every result can expose:
- Last checked time
- Source
- Whether price was refreshed
- Whether connection is protected or self-transfer
- Missing/unknown fare attributes
- Explanation of rank

## Explicit warnings
- Split/self-transfer
- Mixed cabin
- Airport change
- Overnight layover
- Very short connection
- Long connection
- Basic-economy restrictions when known
- Price not revalidated

## Ranking labels
Do not claim universal "best" without context. "Best trade-off" means best under the user's visible/default preference weights. The explanation must list the decisive factors.
