import { compareMoney, MoneySchema, type FlightOffer, type Journey, type Money } from "@flightbrain/domain";

export type RankMetrics = {
  price: Money;
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
    price: MoneySchema.parse(offer.totalPrice),
    durationMinutes: durationMinutes(offer),
    stops: offer.journeys.reduce((total, journey) => total + Math.max(0, journey.segments.length - 1), 0),
    warningCount: offer.warnings.length,
  };
}

export function dominates(a: RankMetrics, b: RankMetrics): boolean {
  // Native currencies are incomparable without an explicit conversion policy.
  if (a.price.currency !== b.price.currency) return false;
  const priceComparison = compareMoney(a.price, b.price);
  const noWorse =
    priceComparison <= 0 &&
    a.durationMinutes <= b.durationMinutes &&
    a.stops <= b.stops &&
    a.warningCount <= b.warningCount;
  const strictlyBetter =
    priceComparison < 0 ||
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

function approximatePricePenalty(amount: bigint, minimum: bigint): number {
  if (minimum === 0n) return 0; // Preserve the starter's zero-minimum policy for C003.
  const numerator = (amount - minimum) * 50n;
  const whole = numerator / minimum;
  const fraction = ((numerator % minimum) * 1_000_000_000_000n) / minimum;
  // Only this dimensionless score crosses to number. Money and all comparisons
  // stay exact; the score fraction is truncated to 12 decimal places, never fares.
  return Number(whole) + Number(fraction) / 1_000_000_000_000;
}

export function rankOffers(offers: FlightOffer[]): RankedOffer[] {
  if (!offers.length) return [];
  const metrics = offers.map(metricsFor);
  if (metrics.some((m) => m.price.currency !== metrics[0].price.currency)) {
    throw new RangeError("Cannot rank different currencies without explicit FX conversion");
  }
  const minPrice = metrics.reduce((min, m) => compareMoney(m.price, min) < 0 ? m.price : min, metrics[0].price);
  const minAmount = BigInt(minPrice.amountMinor);
  const minDuration = Math.min(...metrics.map((m) => m.durationMinutes));

  return offers
    .map((offer) => {
      const m = metricsFor(offer);
      const pricePenalty = approximatePricePenalty(BigInt(m.price.amountMinor), minAmount);
      const durationPenalty = minDuration === 0 ? 0 : (m.durationMinutes / minDuration - 1) * 25;
      const stopPenalty = m.stops * 12;
      const warningPenalty = m.warningCount * 8;
      const score = 100 - pricePenalty - durationPenalty - stopPenalty - warningPenalty;
      const reasons: string[] = [];
      if (compareMoney(m.price, minPrice) === 0) reasons.push("Lowest observed price in this result set");
      if (m.durationMinutes === minDuration) reasons.push("Fastest observed itinerary in this result set");
      if (m.stops === 0) reasons.push("Nonstop");
      if (m.warningCount === 0) reasons.push("No detected itinerary warnings");
      return { offer, metrics: m, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}
