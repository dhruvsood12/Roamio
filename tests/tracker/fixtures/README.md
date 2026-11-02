# Tracker adapter fixtures

`aeroapi.json` is **synthetic test data**, authored against the official
[AeroAPI OpenAPI 4.17.1](https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml).
It is not a captured response or evidence of a real flight. No authorized API key
or genuine response fixture was available. Official AeroApps and FIDS example
repositories did not contain captured response fixtures. Live smoke testing and
sanitized captured-response validation remain pending authorized credentials.

The fixture exercises documented field names, nullability and units. Position
and airport-detail responses are constructed explicitly in the adapter tests.
