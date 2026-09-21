import { describe, expect, it } from "vitest";
import {
  createTripOption, FlightOfferSchema, TripOptionSchema, TripSourceSnapshotSchema,
  type TripOption, type TripSourceSnapshot,
} from "@flightbrain/domain";
import { singlePlan, splitPlan } from "./fixtures/trips";

const privateMetadata = {
  accessToken: "SYNTHETIC-SECRET",
  rawResponse: { privateFareCode: "SYNTHETIC-PRIVATE" },
};
const privateText = ["providerMetadata", "accessToken", "SYNTHETIC-SECRET", "rawResponse", "privateFareCode", "SYNTHETIC-PRIVATE"];

function freezeDeep(value: unknown): void {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
}

describe("safe trip source snapshots", () => {
  it.each([0, 1, 10, 50])("excludes private metadata at nesting depth %i without mutating any input", (depth) => {
    const plan = splitPlan();
    let nested: unknown = privateMetadata;
    for (let i = 0; i < depth; i++) nested = { children: [nested] };
    for (const source of plan.sourceOffers) source.providerMetadata = { nested };
    const before = structuredClone(plan);
    freezeDeep(plan);
    const trip = createTripOption(plan);
    const serialized = JSON.stringify(trip);
    for (const text of privateText) expect(serialized).not.toContain(text);
    expect(plan).toEqual(before);
    expect(FlightOfferSchema.parse(plan.sourceOffers[0]).providerMetadata).toEqual({ nested });
    expect(TripOptionSchema.parse(JSON.parse(serialized))).toEqual(trip);
  });

  it("retains the explicitly selected source facts and component references", () => {
    const plan = singlePlan();
    const source = plan.sourceOffers[0];
    Object.assign(source, {
      providerMetadata: privateMetadata,
      bookingUrl: "https://booking.example/offers/one-offer",
      expiresAt: "2026-09-17T11:00:00Z",
      taxes: { amountMinor: "5000", currency: "USD", exponent: 2 },
      fareBrand: "Synthetic Flex", refundable: true, changeable: false, checkedBags: 1, cabinBags: 0,
      warnings: ["self_transfer"],
    });
    const before = structuredClone(source);
    const trip = createTripOption(plan);
    const snapshot = trip.sourceOffers[0];
    expect(Object.keys(snapshot).sort()).toEqual([
      "id", "journeys", "provider", "providerOfferId", "bookingUrl", "retrievedAt", "expiresAt",
      "requiresRevalidation", "totalPrice", "taxes", "fareBrand", "refundable", "changeable",
      "checkedBags", "cabinBags", "warnings",
    ].sort());
    const { providerMetadata, ...safeFacts } = before;
    expect(snapshot).toEqual(safeFacts);
    expect(trip.bookingComponents).toEqual(plan.bookingComponents);
    expect(trip.bookingComponents[0]).toMatchObject({
      sourceOfferIndex: 0, provider: snapshot.provider, providerOfferId: snapshot.providerOfferId,
      offerId: snapshot.id, scheduleFingerprint: plan.bookingComponents[0].scheduleFingerprint,
    });
    expect(trip.payment.cashByCurrency).toEqual([source.totalPrice]);
    expect(trip.connections).toHaveLength(2);
    expect(trip.connections.every(c => c.protection === "unknown")).toBe(true);
    expect(trip.warnings).toEqual(["self_transfer", "unknown_connection_protection"]);
    expect(TripSourceSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(source).toEqual(before);
    snapshot.journeys[0].segments[0].destination = "SEA";
    snapshot.totalPrice.amountMinor = "1";
    snapshot.taxes!.amountMinor = "1";
    snapshot.warnings.push("stale_price");
    expect(source).toEqual(before);
  });

  it.each(["providerMetadata", "accessToken", "rawResponse", "futureProviderField"])("rejects injected snapshot field %s", (field) => {
    const trip = createTripOption(singlePlan());
    const unsafe = { ...trip.sourceOffers[0], [field]: privateMetadata };
    expect(TripSourceSnapshotSchema.safeParse(unsafe).success).toBe(false);
    expect(TripOptionSchema.safeParse({ ...trip, sourceOffers: [unsafe] }).success).toBe(false);
  });

  const sourceChanges: [string, (s: TripSourceSnapshot) => void][] = [
    ["expiry before retrieval", s => { s.expiresAt = s.retrievedAt; }],
    ["taxes exceeding inclusive total", s => { s.taxes = { ...s.totalPrice, amountMinor: "50001" }; }],
    ["tax currency mismatch", s => { s.taxes = { ...s.totalPrice, currency: "EUR" }; }],
    ["malformed tax amount", s => { s.taxes = { ...s.totalPrice, amountMinor: "not-money" }; }],
    ["missing airport-change warning", s => { s.journeys[0].segments[1].origin = "HND"; }],
    ["missing mixed-cabin warning", s => { s.journeys[0].segments[1].cabin = "business"; }],
    ["overlapping source segments", s => { s.journeys[0].segments[1].departureAt = "2026-10-10T07:00:00Z"; }],
  ];
  it.each(sourceChanges)("preserves source validation for %s", (_, mutate) => {
    const trip = createTripOption(singlePlan()); mutate(trip.sourceOffers[0]);
    expect(() => TripSourceSnapshotSchema.safeParse(trip.sourceOffers[0])).not.toThrow();
    expect(TripSourceSnapshotSchema.safeParse(trip.sourceOffers[0]).success).toBe(false);
    expect(() => TripOptionSchema.safeParse(trip)).not.toThrow();
    expect(TripOptionSchema.safeParse(trip).success).toBe(false);
  });

  const tripChanges: [string, (t: TripOption) => void][] = [
    ["removed referenced source segment", t => { t.sourceOffers[0].journeys[0].segments.pop(); }],
    ["duplicated source segment", t => { t.sourceOffers[0].journeys[0].segments.push({ ...t.sourceOffers[0].journeys[0].segments[2] }); }],
    ["duplicated segment reference", t => { t.travel.journeys[0].segments.push({ ...t.travel.journeys[0].segments[2] }); }],
    ["omitted final segment reference", t => { t.travel.journeys[0].segments.pop(); t.travel.journeys[0].requestedDestination = "LAX"; }],
    ["provider mismatch", t => { t.sourceOffers[0].provider = "another-provider"; }],
    ["provider offer mismatch", t => { t.sourceOffers[0].providerOfferId = "another-offer"; }],
    ["observation mismatch", t => { t.sourceOffers[0].id = "another-observation"; }],
    ["cash mismatch", t => { t.sourceOffers[0].totalPrice.amountMinor = "1"; }],
    ["omitted connection", t => { t.connections.pop(); }],
    ["omitted warning", t => { t.warnings = []; }],
    ["changed booking boundary", t => { t.connections[0].crossesBookingBoundary = true; }],
    ["invented operating identity", t => { t.sourceOffers[0].journeys[0].segments[0].operatingFlightNumber = null; }],
  ];
  it.each(tripChanges)("rejects %s after projecting and serializing sources", (_, mutate) => {
    const trip: TripOption = JSON.parse(JSON.stringify(createTripOption(singlePlan())));
    mutate(trip);
    expect(() => TripOptionSchema.safeParse(trip)).not.toThrow();
    expect(TripOptionSchema.safeParse(trip).success).toBe(false);
  });

  it("rejects an unreferenced booked onward leg even when the projected source remains valid", () => {
    const trip: TripOption = JSON.parse(JSON.stringify(createTripOption(singlePlan())));
    const source = trip.sourceOffers[0];
    source.journeys[0].segments.push({ ...source.journeys[0].segments[2], origin: "SFO", destination: "SEA",
      departureAt: "2026-10-11T02:00:00Z", arrivalAt: "2026-10-11T04:00:00Z" });
    expect(TripSourceSnapshotSchema.safeParse(source).success).toBe(true);
    const result = TripOptionSchema.safeParse(trip);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: "Every selected source segment must be flown exactly once in source order",
    }));
  });

  it.each([
    ["trip", (t: TripOption) => t],
    ["component", (t: TripOption) => t.bookingComponents[0]],
    ["payment quote", (t: TripOption) => t.bookingComponents[0].payment],
    ["money", (t: TripOption) => t.sourceOffers[0].totalPrice],
    ["source journey", (t: TripOption) => t.sourceOffers[0].journeys[0]],
    ["source segment", (t: TripOption) => t.sourceOffers[0].journeys[0].segments[0]],
    ["travel", (t: TripOption) => t.travel],
    ["trip journey", (t: TripOption) => t.travel.journeys[0]],
    ["segment reference", (t: TripOption) => t.travel.journeys[0].segments[0]],
    ["payment summary", (t: TripOption) => t.payment],
    ["connection", (t: TripOption) => t.connections[0]],
    ["protection evidence", (t: TripOption) => t.connections[0].evidence],
  ] as const)("rejects an unrestricted provider object injected into %s", (_, select) => {
    const trip = createTripOption(singlePlan());
    Object.assign(select(trip), { providerMetadata: privateMetadata });
    expect(TripOptionSchema.safeParse(trip).success).toBe(false);
  });
});
