import { createHash } from "node:crypto";
import type { FlightOffer } from "@flightbrain/domain";

export type ScheduleFingerprint = `fb:schedule:v1:${string}`;

export type ItineraryGroup = {
  scheduleFingerprint: ScheduleFingerprint | null;
  offers: FlightOffer[];
};

type CanonicalSegment = [
  origin: string,
  destination: string,
  operatingCarrier: string,
  operatingFlightNumber: string,
  departureInstant: string,
  arrivalInstant: string,
];

function normalizeScheduleInstant(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

// Accepts canonical FlightOffer data. V1 semantics are fixed; see DOMAIN_CONTRACTS.md.
// This identifies an exact schedule, not a permanent flight or a commercial offer.
export function itineraryFingerprint(offer: FlightOffer): ScheduleFingerprint | null {
  const canonicalJourneys: CanonicalSegment[][] = [];
  for (const journey of offer.journeys) {
    const canonicalSegments: CanonicalSegment[] = [];
    for (const segment of journey.segments) {
      if (segment.operatingCarrier == null || segment.operatingFlightNumber == null) return null;
      canonicalSegments.push([
        segment.origin,
        segment.destination,
        segment.operatingCarrier,
        segment.operatingFlightNumber,
        normalizeScheduleInstant(segment.departureAt),
        normalizeScheduleInstant(segment.arrivalAt),
      ]);
    }
    canonicalJourneys.push(canonicalSegments);
  }

  const payload = ["flightbrain-schedule", 1, canonicalJourneys] as const;
  const digest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return `fb:schedule:v1:${digest}`;
}

// Group order follows first encounter; offers retain their input order and references.
// Membership is independent of input order. Null never serves as an equality key.
export function groupOffersByItinerary(offers: readonly FlightOffer[]): ItineraryGroup[] {
  const groups: ItineraryGroup[] = [];
  const knownGroups = new Map<ScheduleFingerprint, ItineraryGroup>();
  for (const offer of offers) {
    const scheduleFingerprint = itineraryFingerprint(offer);
    const existing = scheduleFingerprint === null ? undefined : knownGroups.get(scheduleFingerprint);
    if (existing) {
      existing.offers.push(offer);
    } else {
      const group = { scheduleFingerprint, offers: [offer] };
      groups.push(group);
      if (scheduleFingerprint !== null) knownGroups.set(scheduleFingerprint, group);
    }
  }
  return groups;
}
