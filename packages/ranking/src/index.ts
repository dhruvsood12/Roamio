import type { FlightOffer, Journey } from "@flightbrain/domain";

export type RankMetrics = {
  price: number;
  durationMinutes: number;
  stops: number;
  warningCount: number;
};

export type RankedOffer = {
  offer: FlightOffer;
  metrics: RankMetrics;
  score: number;
  reasons: string[];
};

export function journeyDurationMinutes(journey: Journey): number {
  const first = journey.segments[0];
  const last = journey.segments[journey.segments.length - 1];
  return Math.round((Date.parse(last.arrivalAt) - Date.parse(first.departureAt)) / 60_000);
}

export function durationMinutes(offer: FlightOffer): number {
  return offer.journeys.reduce((total, journey) => total + journeyDurationMinutes(journey), 0);
}

export function metricsFor(offer: FlightOffer): RankMetrics {
  return {
    price: offer.totalPrice.amount,
    durationMinutes: durationMinutes(offer),
    stops: offer.journeys.reduce((total, journey) => total + Math.max(0, journey.segments.length - 1), 0),
    warningCount: offer.warnings.length,
  };
}

export function dominates(a: RankMetrics, b: RankMetrics): boolean {
  const noWorse =
    a.price <= b.price &&
    a.durationMinutes <= b.durationMinutes &&
    a.stops <= b.stops &&
    a.warningCount <= b.warningCount;
  const strictlyBetter =
    a.price < b.price ||
    a.durationMinutes < b.durationMinutes ||
    a.stops < b.stops ||
    a.warningCount < b.warningCount;
  return noWorse && strictlyBetter;
}

export function paretoFrontier(offers: FlightOffer[]): FlightOffer[] {
  const pairs = offers.map((offer) => ({ offer, metrics: metricsFor(offer) }));
  return pairs
    .filter((candidate, i) => !pairs.some((other, j) => j !== i && dominates(other.metrics, candidate.metrics)))
    .map((x) => x.offer);
}

export function rankOffers(offers: FlightOffer[]): RankedOffer[] {
  if (!offers.length) return [];
  const metrics = offers.map(metricsFor);
  const minPrice = Math.min(...metrics.map((m) => m.price));
  const minDuration = Math.min(...metrics.map((m) => m.durationMinutes));

  return offers
    .map((offer) => {
      const m = metricsFor(offer);
      const pricePenalty = minPrice === 0 ? 0 : (m.price / minPrice - 1) * 50;
      const durationPenalty = minDuration === 0 ? 0 : (m.durationMinutes / minDuration - 1) * 25;
      const stopPenalty = m.stops * 12;
      const warningPenalty = m.warningCount * 8;
      const score = 100 - pricePenalty - durationPenalty - stopPenalty - warningPenalty;
      const reasons: string[] = [];
      if (m.price === minPrice) reasons.push("Lowest observed price in this result set");
      if (m.durationMinutes === minDuration) reasons.push("Fastest observed itinerary in this result set");
      if (m.stops === 0) reasons.push("Nonstop");
      if (m.warningCount === 0) reasons.push("No detected itinerary warnings");
      return { offer, metrics: m, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}
