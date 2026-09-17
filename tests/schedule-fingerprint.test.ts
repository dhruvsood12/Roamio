import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FlightOfferSchema, type FlightOffer, type Segment } from "@flightbrain/domain";
import { groupOffersByItinerary, itineraryFingerprint } from "@flightbrain/orchestrator";
import { connectingRoundTrip, offerWithJourneys } from "./fixtures/journeys";

// Independently computed with Python hashlib over compact UTF-8 JSON. Changing
// these vectors requires a new fingerprint version, not a replacement V1 digest.
const oneWayFingerprint = "fb:schedule:v1:4ee92e03d824498cb999249eb739d6aa5dfd22b62f8d466ea1ee1fd73827ccd7";
const roundTripFingerprint = "fb:schedule:v1:f4e25b498ad038db5cbb6ff5bce300508f95f2862868f91e7663ce866a32a76a";

function codeshare(): FlightOffer {
  const segment = connectingRoundTrip()[0].segments[0];
  return FlightOfferSchema.parse(offerWithJourneys([{ segments: [{ ...segment,
    marketingCarrier: "BA", marketingFlightNumber: "123", operatingCarrier: "AA", operatingFlightNumber: "456",
  }] }]));
}

describe("Schedule Fingerprint V1", () => {
  it("locks the payload field order, version, serialization and digest for a single journey", () => {
    // Exact hashed bytes (no whitespace or trailing newline):
    // ["flightbrain-schedule",1,[[["ARN","LHR","AA","456","2026-10-10T06:00:00.000Z","2026-10-10T08:00:00.000Z"]]]]
    expect(itineraryFingerprint(codeshare())).toBe(oneWayFingerprint);
    expect(itineraryFingerprint(codeshare())).toMatch(/^fb:schedule:v1:[0-9a-f]{64}$/);
  });

  it("locks nested segment and journey serialization for a connecting round trip", () => {
    expect(itineraryFingerprint(FlightOfferSchema.parse(offerWithJourneys(connectingRoundTrip()))))
      .toBe(roundTripFingerprint);
  });

  it.each([
    ["2026-10-10T06:00:00Z", "2026-10-10T08:00:00Z"],
    ["2026-10-10T08:00:00+02:00", "2026-10-10T01:00:00-07:00"],
    ["2026-10-09T23:00:00-07:00", "2026-10-10T10:00:00+02:00"],
    ["2026-10-10T06:00:00+00:00", "2026-10-10T08:00:00.000Z"],
    ["2026-10-10T06:00:00.0Z", "2026-10-10T08:00:00.00Z"],
  ])("canonicalizes equivalent instants %s / %s", (departureAt, arrivalAt) => {
    const offer = codeshare();
    Object.assign(offer.journeys[0].segments[0], { departureAt, arrivalAt });
    expect(itineraryFingerprint(FlightOfferSchema.parse(offer))).toBe(oneWayFingerprint);
  });

  it("preserves milliseconds while normalizing offsets and fractional precision", () => {
    const a = codeshare();
    Object.assign(a.journeys[0].segments[0], {
      departureAt: "2026-10-10T06:00:00.1Z", arrivalAt: "2026-10-10T08:00:00.123Z",
    });
    const b = structuredClone(a);
    Object.assign(b.journeys[0].segments[0], {
      departureAt: "2026-10-10T08:00:00.100+02:00", arrivalAt: "2026-10-10T01:00:00.123-07:00",
    });
    expect(itineraryFingerprint(FlightOfferSchema.parse(a))).toBe(itineraryFingerprint(FlightOfferSchema.parse(b)));
    expect(itineraryFingerprint(a)).not.toBe(oneWayFingerprint);
  });

  const scheduleChanges: [keyof Segment, string][] = [
    ["origin", "CPH"], ["destination", "LAX"],
    ["operatingCarrier", "AA"], ["operatingFlightNumber", "999"],
    ["departureAt", "2026-10-10T06:00:00.001Z"],
    ["arrivalAt", "2026-10-10T08:00:00.001Z"],
  ];
  const positions = [[0, 0], [0, 1], [1, 0], [1, 1]] as const;
  it.each(positions.flatMap(([journey, segment]) => scheduleChanges.map(([field, value]) => ({ journey, segment, field, value }))))(
    "includes $field on journey $journey segment $segment", ({ journey, segment, field, value }) => {
      const offer = offerWithJourneys(connectingRoundTrip());
      const selected = offer.journeys[journey].segments[segment];
      // Shift the selected timestamp by exactly 1 ms without altering the route's chronology.
      const next = field === "departureAt" || field === "arrivalAt"
        ? new Date(Date.parse(selected[field]) + 1).toISOString() : value;
      Object.assign(selected, { [field]: next });
      if (field === "origin" || field === "destination") offer.warnings = ["airport_change"];
      const fingerprint = itineraryFingerprint(FlightOfferSchema.parse(offer));
      expect(fingerprint).not.toBe(roundTripFingerprint);
      expect(fingerprint).not.toBeNull();
    },
  );

  it("keeps even five-minute schedule disagreements in separate groups", () => {
    const a = codeshare();
    const b = structuredClone(a);
    b.journeys[0].segments[0].arrivalAt = "2026-10-10T08:05:00Z";
    expect(groupOffersByItinerary([a, FlightOfferSchema.parse(b)])).toHaveLength(2);
  });

  it("does not equate IATA and ICAO carrier identifiers", () => {
    const a = codeshare();
    const b = structuredClone(a);
    b.journeys[0].segments[0].operatingCarrier = "AAL";
    expect(itineraryFingerprint(FlightOfferSchema.parse(b))).not.toBe(itineraryFingerprint(a));
  });

  it("keeps opaque flight numbers distinct without stripping, parsing or Unicode normalization", () => {
    const spellings = ["123", "00123", "123A", "AA123", "12 3", "12-3", "12|3", "12~3", '12\"3', "12\\3", "é", "e\u0301"];
    const fingerprints = spellings.map((operatingFlightNumber) => {
      const offer = codeshare();
      offer.journeys[0].segments[0].operatingFlightNumber = operatingFlightNumber;
      const parsed = FlightOfferSchema.parse(offer);
      expect(parsed.journeys[0].segments[0].operatingFlightNumber).toBe(operatingFlightNumber);
      return itineraryFingerprint(parsed);
    });
    expect(fingerprints).not.toContain(null);
    expect(new Set(fingerprints).size).toBe(spellings.length);
  });

  it("preserves boundaries, journey order, segment order and segment multiplicity", () => {
    const [outbound, inbound] = connectingRoundTrip();
    const regular = offerWithJourneys([outbound, inbound]);
    const flattened = offerWithJourneys([{ segments: [...outbound.segments, ...inbound.segments] }]);
    const split = offerWithJourneys([
      { segments: [outbound.segments[0]] }, { segments: [outbound.segments[1]] }, inbound,
    ]);
    const journeyReordered = offerWithJourneys([inbound, outbound]);
    const segmentReordered = offerWithJourneys([
      { segments: [outbound.segments[1], outbound.segments[0]] }, inbound,
    ]);
    const fewerSegments = offerWithJourneys([{ segments: [outbound.segments[0]] }, inbound]);
    const repeatedJourney = offerWithJourneys([outbound, inbound, outbound]);
    const valid = [regular, flattened, split, journeyReordered, fewerSegments, repeatedJourney];
    for (const offer of valid) expect(FlightOfferSchema.safeParse(offer).success).toBe(true);
    // Reversing travel chronology is invalid domain data; the serialization must
    // still preserve the supplied sequence rather than sorting it into equality.
    expect(FlightOfferSchema.safeParse(segmentReordered).success).toBe(false);
    const signatures = [...valid, segmentReordered].map(itineraryFingerprint);
    expect(signatures).not.toContain(null);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it.each(positions.flatMap(([journey, segment]) => [
    { journey, segment, identity: { operatingCarrier: null, operatingFlightNumber: "100" } },
    { journey, segment, identity: { operatingCarrier: "SK", operatingFlightNumber: null } },
    { journey, segment, identity: { operatingCarrier: null, operatingFlightNumber: null } },
  ]))("returns null for partial identity at journey $journey segment $segment: $identity", ({ journey, segment, identity }) => {
    const offer = offerWithJourneys(connectingRoundTrip());
    Object.assign(offer.journeys[journey].segments[segment], identity);
    expect(itineraryFingerprint(FlightOfferSchema.parse(offer))).toBeNull();
  });

  it("avoids a demonstrable delimiter collision inside arbitrary flight-number text", () => {
    const [journey] = connectingRoundTrip();
    const a = offerWithJourneys([journey]);
    const b = structuredClone(a);
    const [first, second] = journey.segments;
    const middle = [new Date(first.departureAt).toISOString(), new Date(first.arrivalAt).toISOString(),
      second.origin, second.destination, second.operatingCarrier].join("|");
    a.journeys[0].segments[0].operatingFlightNumber = `100|${middle}|101`;
    a.journeys[0].segments[1].operatingFlightNumber = "102";
    b.journeys[0].segments[0].operatingFlightNumber = "100";
    b.journeys[0].segments[1].operatingFlightNumber = `101|${middle}|102`;
    // Deliberately unsafe test comparison; this must never become a production key.
    const delimiterKey = (offer: FlightOffer) => offer.journeys.flatMap((j) => j.segments.flatMap((s) => [
      s.origin, s.destination, s.operatingCarrier, s.operatingFlightNumber,
      new Date(s.departureAt).toISOString(), new Date(s.arrivalAt).toISOString(),
    ])).join("|");
    expect(delimiterKey(a)).toBe(delimiterKey(b));
    expect(itineraryFingerprint(FlightOfferSchema.parse(a))).not.toBe(itineraryFingerprint(FlightOfferSchema.parse(b)));
    expect(groupOffersByItinerary([a, b])).toHaveLength(2);
  });

  it("escapes JSON-looking identifiers without introducing extra fields or segments", () => {
    const a = codeshare();
    const b = codeshare();
    a.journeys[0].segments[0].operatingFlightNumber = '456"],["ARN","LHR","AA","789';
    b.journeys[0].segments.push({ ...b.journeys[0].segments[0], origin: "LHR", destination: "SAN",
      operatingFlightNumber: "789", departureAt: "2026-10-10T09:00:00Z", arrivalAt: "2026-10-10T21:00:00Z" });
    expect(itineraryFingerprint(FlightOfferSchema.parse(a))).not.toBe(itineraryFingerprint(FlightOfferSchema.parse(b)));
  });

  it("is stable across repeated calls, clones and property insertion order", () => {
    const offer = codeshare();
    const reverseProperties = <T extends object>(value: T): T =>
      Object.fromEntries(Object.entries(value).reverse()) as T;
    const reordered = reverseProperties(structuredClone(offer));
    for (const journey of reordered.journeys) {
      journey.segments.forEach((segment, i) => { journey.segments[i] = reverseProperties(segment); });
    }
    expect(FlightOfferSchema.safeParse(reordered).success).toBe(true);
    for (let i = 0; i < 10; i++) expect(itineraryFingerprint(offer)).toBe(oneWayFingerprint);
    expect(itineraryFingerprint(reordered)).toBe(oneWayFingerprint);
  });

  it.each(["UTC", "Europe/Stockholm", "Pacific/Honolulu"])("is stable in a fresh process with TZ=%s", (timezone) => {
    // Run the production module in Node, independent of Vitest's module cache.
    const moduleUrl = new URL("../packages/orchestrator/src/schedule.ts", import.meta.url).href;
    const script = `import { itineraryFingerprint } from ${JSON.stringify(moduleUrl)};
      import { readFileSync } from 'node:fs';
      process.stdout.write(itineraryFingerprint(JSON.parse(readFileSync(0, 'utf8'))));`;
    const fingerprint = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
      input: JSON.stringify(codeshare()), encoding: "utf8", env: { ...process.env, TZ: timezone },
    });
    expect(fingerprint).toBe(oneWayFingerprint);
  });
});
