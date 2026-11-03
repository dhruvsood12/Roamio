import {
  CURRENCY_METADATA_V1,
  FlightOfferSchema,
  type FlightOffer,
  type SupportedCurrencyCode,
} from "@flightbrain/domain";
import { addMs, prngSequence, syntheticCarrier, syntheticFlightNumber, syntheticOfferId } from "../synthetic";

export type MockProviderScenario =
  | "nonstop"
  | "one_stop"
  | "codeshare"
  | "airport_change"
  | "self_transfer"
  | "mixed_cabin"
  | "stale"
  | "duplicate"
  | "no_results"
  | "provider_error"
  | "timeout";

export interface ScenarioConfig {
  providerId: string;
  asOf: string;
  seed: number;
  currency: SupportedCurrencyCode;
  offerValidityMs: number;
  /** Origin airport for the outbound segment */
  origin: string;
  /** Destination airport for the outbound segment */
  destination: string;
  /** Departure date string YYYY-MM-DD */
  departureDate: string;
}

function makeTimestamps(departureDate: string, asOf: string, offerValidityMs: number) {
  const baseDepMs = Date.parse(`${departureDate}T08:00:00.000Z`);
  return { baseDepMs, expiresAt: offerValidityMs > 0 ? addMs(asOf, offerValidityMs) : null };
}

function money(amountMinor: string, currency: SupportedCurrencyCode) {
  return { amountMinor, currency, exponent: CURRENCY_METADATA_V1.exponents[currency] };
}

// Candidate co-located airport pairs (same metro area). The airport_change scenario
// lands at one and departs the other. We pick a pair whose members differ from both
// request endpoints so the synthesized segments never collide origin === destination.
const AIRPORT_CHANGE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["LGW", "LHR"], // London Gatwick / Heathrow
  ["LIN", "BGY"], // Milan Linate / Bergamo
  ["HND", "NRT"], // Tokyo Haneda / Narita
  ["GIG", "SDU"], // Rio Galeão / Santos Dumont
];

/** Pick a co-located airport pair that collides with neither endpoint. */
function pickAirportChangePair(origin: string, destination: string): readonly [string, string] {
  for (const pair of AIRPORT_CHANGE_PAIRS) {
    if (pair[0] !== origin && pair[0] !== destination && pair[1] !== origin && pair[1] !== destination) {
      return pair;
    }
  }
  // Every curated pair collided; fall back to two clearly-synthetic codes. "ZZZ"/"ZYZ"
  // are not real IATA codes but satisfy the AAA shape and will differ from real endpoints.
  return ["ZZZ", "ZYZ"];
}

function baseOffer(
  id: string,
  providerId: string,
  asOf: string,
  expiresAt: string | null,
  currency: SupportedCurrencyCode,
  priceMinor: string,
): Omit<FlightOffer, "id" | "journeys" | "warnings"> {
  return {
    provider: providerId,
    providerOfferId: id,
    bookingUrl: null,
    retrievedAt: asOf,
    expiresAt,
    requiresRevalidation: true,
    providerMetadata: { synthetic: true, disclaimer: "Synthetic data — not a real offer. For testing only." },
    totalPrice: money(priceMinor, currency),
    refundable: null,
    changeable: null,
    checkedBags: null,
    cabinBags: null,
  };
}

/** Build nonstop offers: single-journey, single-segment flights */
export function buildNonstopOffers(cfg: ScenarioConfig, count = 3): FlightOffer[] {
  const { baseDepMs, expiresAt } = makeTimestamps(cfg.departureDate, cfg.asOf, cfg.offerValidityMs);
  const rands = prngSequence(`nonstop:${cfg.origin}:${cfg.destination}:${cfg.departureDate}`, cfg.seed, count * 4);
  return Array.from({ length: count }, (_, i) => {
    const ri = i * 4;
    const depMs = baseDepMs + Math.floor(rands[ri] * 6 * 3600_000);
    const arrMs = depMs + (120 + Math.floor(rands[ri + 1] * 240)) * 60_000;
    const carrier = syntheticCarrier(rands[ri + 2]);
    const flightNum = syntheticFlightNumber(rands[ri + 3]);
    const id = syntheticOfferId(cfg.providerId, "nonstop", i);
    return FlightOfferSchema.parse({
      ...baseOffer(id, cfg.providerId, cfg.asOf, expiresAt, cfg.currency, String(20000 + i * 1000)),
      id,
      journeys: [{
        segments: [{
          origin: cfg.origin, destination: cfg.destination,
          departureAt: new Date(depMs).toISOString(),
          arrivalAt: new Date(arrMs).toISOString(),
          marketingCarrier: carrier, marketingFlightNumber: flightNum,
          operatingCarrier: null, operatingFlightNumber: null, cabin: "economy",
        }],
      }],
      warnings: [],
    });
  });
}

/** Build one_stop offer: single-journey with 2 segments via a hub */
export function buildOneStopOffers(cfg: ScenarioConfig, count = 2): FlightOffer[] {
  const { baseDepMs, expiresAt } = makeTimestamps(cfg.departureDate, cfg.asOf, cfg.offerValidityMs);
  const HUB = "FRA";
  const rands = prngSequence(`one_stop:${cfg.origin}:${cfg.destination}:${cfg.departureDate}`, cfg.seed, count * 6);
  return Array.from({ length: count }, (_, i) => {
    const ri = i * 6;
    const dep1Ms = baseDepMs + Math.floor(rands[ri] * 4 * 3600_000);
    const arr1Ms = dep1Ms + (90 + Math.floor(rands[ri + 1] * 180)) * 60_000;
    const dep2Ms = arr1Ms + 90 * 60_000; // 90min layover
    const arr2Ms = dep2Ms + (90 + Math.floor(rands[ri + 2] * 180)) * 60_000;
    const carrier1 = syntheticCarrier(rands[ri + 3]);
    const carrier2 = syntheticCarrier(rands[ri + 4]);
    const fnum1 = syntheticFlightNumber(rands[ri + 5]);
    const fnum2 = syntheticFlightNumber(rands[ri] * 0.5); // reuse rand
    const id = syntheticOfferId(cfg.providerId, "one_stop", i);
    return FlightOfferSchema.parse({
      ...baseOffer(id, cfg.providerId, cfg.asOf, expiresAt, cfg.currency, String(30000 + i * 1500)),
      id,
      journeys: [{
        segments: [
          {
            origin: cfg.origin, destination: HUB,
            departureAt: new Date(dep1Ms).toISOString(),
            arrivalAt: new Date(arr1Ms).toISOString(),
            marketingCarrier: carrier1, marketingFlightNumber: fnum1,
            operatingCarrier: null, operatingFlightNumber: null, cabin: "economy",
          },
          {
            origin: HUB, destination: cfg.destination,
            departureAt: new Date(dep2Ms).toISOString(),
            arrivalAt: new Date(arr2Ms).toISOString(),
            marketingCarrier: carrier2, marketingFlightNumber: fnum2,
            operatingCarrier: null, operatingFlightNumber: null, cabin: "economy",
          },
        ],
      }],
      warnings: [],
    });
  });
}

/** Build codeshare offer: operatingCarrier/Number distinct from marketing */
export function buildCodeshareOffers(cfg: ScenarioConfig, count = 2): FlightOffer[] {
  const { baseDepMs, expiresAt } = makeTimestamps(cfg.departureDate, cfg.asOf, cfg.offerValidityMs);
  const rands = prngSequence(`codeshare:${cfg.origin}:${cfg.destination}:${cfg.departureDate}`, cfg.seed, count * 4);
  return Array.from({ length: count }, (_, i) => {
    const ri = i * 4;
    const depMs = baseDepMs + Math.floor(rands[ri] * 3 * 3600_000);
    const arrMs = depMs + (150 + Math.floor(rands[ri + 1] * 300)) * 60_000;
    const marketingCarrier = "ZZ";
    const marketingFnum = syntheticFlightNumber(rands[ri + 2]);
    const operatingCarrier = "ZY"; // always different from ZZ
    const operatingFnum = syntheticFlightNumber(rands[ri + 3]);
    const id = syntheticOfferId(cfg.providerId, "codeshare", i);
    return FlightOfferSchema.parse({
      ...baseOffer(id, cfg.providerId, cfg.asOf, expiresAt, cfg.currency, String(25000 + i * 2000)),
      id,
      journeys: [{
        segments: [{
          origin: cfg.origin, destination: cfg.destination,
          departureAt: new Date(depMs).toISOString(),
          arrivalAt: new Date(arrMs).toISOString(),
          marketingCarrier, marketingFlightNumber: marketingFnum,
          operatingCarrier, operatingFlightNumber: operatingFnum,
          cabin: "economy",
        }],
      }],
      warnings: [],
    });
  });
}

/** Build airport_change offer: segment[1].origin != segment[0].destination within a journey */
export function buildAirportChangeOffers(cfg: ScenarioConfig, count = 1): FlightOffer[] {
  const { baseDepMs, expiresAt } = makeTimestamps(cfg.departureDate, cfg.asOf, cfg.offerValidityMs);
  const rands = prngSequence(`airport_change:${cfg.origin}:${cfg.destination}:${cfg.departureDate}`, cfg.seed, count * 4);
  // Two co-located airports that serve the same metro area (e.g. London's LGW/LHR,
  // or Milan's LIN/BGY). The passenger lands at one and departs the other — an
  // airport change. The pair is chosen to avoid colliding with the request endpoints.
  const [arrivalAirport, departureAirport] = pickAirportChangePair(cfg.origin, cfg.destination);
  return Array.from({ length: count }, (_, i) => {
    const ri = i * 4;
    const dep1Ms = baseDepMs + Math.floor(rands[ri] * 2 * 3600_000);
    const arr1Ms = dep1Ms + (150 + Math.floor(rands[ri + 1] * 200)) * 60_000;
    const dep2Ms = arr1Ms + 120 * 60_000; // 2h transfer time for airport change
    const arr2Ms = dep2Ms + (90 + Math.floor(rands[ri + 2] * 120)) * 60_000;
    const carrier = syntheticCarrier(rands[ri + 3]);
    const id = syntheticOfferId(cfg.providerId, "airport_change", i);
    return FlightOfferSchema.parse({
      ...baseOffer(id, cfg.providerId, cfg.asOf, expiresAt, cfg.currency, String(28000 + i * 2000)),
      id,
      journeys: [{
        segments: [
          {
            origin: cfg.origin, destination: arrivalAirport,
            departureAt: new Date(dep1Ms).toISOString(),
            arrivalAt: new Date(arr1Ms).toISOString(),
            marketingCarrier: carrier, marketingFlightNumber: "201",
            operatingCarrier: null, operatingFlightNumber: null, cabin: "economy",
          },
          {
            origin: departureAirport, destination: cfg.destination, // different from arrivalAirport!
            departureAt: new Date(dep2Ms).toISOString(),
            arrivalAt: new Date(arr2Ms).toISOString(),
            marketingCarrier: carrier, marketingFlightNumber: "202",
            operatingCarrier: null, operatingFlightNumber: null, cabin: "economy",
          },
        ],
      }],
      warnings: ["airport_change"],
    });
  });
}

/** Build self_transfer offer: 2 independent journeys — passenger responsible for own connection */
export function buildSelfTransferOffers(cfg: ScenarioConfig, count = 1): FlightOffer[] {
  const { baseDepMs, expiresAt } = makeTimestamps(cfg.departureDate, cfg.asOf, cfg.offerValidityMs);
  const HUB = "AMS";
  const rands = prngSequence(`self_transfer:${cfg.origin}:${cfg.destination}:${cfg.departureDate}`, cfg.seed, count * 6);
  return Array.from({ length: count }, (_, i) => {
    const ri = i * 6;
    const dep1Ms = baseDepMs + Math.floor(rands[ri] * 2 * 3600_000);
    const arr1Ms = dep1Ms + (90 + Math.floor(rands[ri + 1] * 120)) * 60_000;
    // Second journey departs hours later (self-transfer: not guaranteed connection)
    const dep2Ms = arr1Ms + 4 * 3600_000;
    const arr2Ms = dep2Ms + (90 + Math.floor(rands[ri + 2] * 120)) * 60_000;
    const carrier1 = syntheticCarrier(rands[ri + 3]);
    const carrier2 = syntheticCarrier(rands[ri + 4]);
    const fnum1 = syntheticFlightNumber(rands[ri + 5]);
    const fnum2 = syntheticFlightNumber(rands[ri + 2] * 0.7);
    const id = syntheticOfferId(cfg.providerId, "self_transfer", i);
    return FlightOfferSchema.parse({
      ...baseOffer(id, cfg.providerId, cfg.asOf, expiresAt, cfg.currency, String(22000 + i * 1200)),
      id,
      journeys: [
        {
          segments: [{
            origin: cfg.origin, destination: HUB,
            departureAt: new Date(dep1Ms).toISOString(),
            arrivalAt: new Date(arr1Ms).toISOString(),
            marketingCarrier: carrier1, marketingFlightNumber: fnum1,
            operatingCarrier: null, operatingFlightNumber: null, cabin: "economy",
          }],
        },
        {
          segments: [{
            origin: HUB, destination: cfg.destination,
            departureAt: new Date(dep2Ms).toISOString(),
            arrivalAt: new Date(arr2Ms).toISOString(),
            marketingCarrier: carrier2, marketingFlightNumber: fnum2,
            operatingCarrier: null, operatingFlightNumber: null, cabin: "economy",
          }],
        },
      ],
      warnings: ["self_transfer"],
    });
  });
}

/** Build mixed_cabin offer: segments use different cabins */
export function buildMixedCabinOffers(cfg: ScenarioConfig, count = 1): FlightOffer[] {
  const { baseDepMs, expiresAt } = makeTimestamps(cfg.departureDate, cfg.asOf, cfg.offerValidityMs);
  const HUB = "CDG";
  const rands = prngSequence(`mixed_cabin:${cfg.origin}:${cfg.destination}:${cfg.departureDate}`, cfg.seed, count * 4);
  return Array.from({ length: count }, (_, i) => {
    const ri = i * 4;
    const dep1Ms = baseDepMs + Math.floor(rands[ri] * 2 * 3600_000);
    const arr1Ms = dep1Ms + (120 + Math.floor(rands[ri + 1] * 120)) * 60_000;
    const dep2Ms = arr1Ms + 90 * 60_000;
    const arr2Ms = dep2Ms + (120 + Math.floor(rands[ri + 2] * 120)) * 60_000;
    const carrier = syntheticCarrier(rands[ri + 3]);
    const id = syntheticOfferId(cfg.providerId, "mixed_cabin", i);
    return FlightOfferSchema.parse({
      ...baseOffer(id, cfg.providerId, cfg.asOf, expiresAt, cfg.currency, String(55000 + i * 5000)),
      id,
      journeys: [{
        segments: [
          {
            origin: cfg.origin, destination: HUB,
            departureAt: new Date(dep1Ms).toISOString(),
            arrivalAt: new Date(arr1Ms).toISOString(),
            marketingCarrier: carrier, marketingFlightNumber: "301",
            operatingCarrier: null, operatingFlightNumber: null, cabin: "economy",
          },
          {
            origin: HUB, destination: cfg.destination,
            departureAt: new Date(dep2Ms).toISOString(),
            arrivalAt: new Date(arr2Ms).toISOString(),
            marketingCarrier: carrier, marketingFlightNumber: "302",
            operatingCarrier: null, operatingFlightNumber: null, cabin: "business", // different cabin!
          },
        ],
      }],
      warnings: ["mixed_cabin"],
    });
  });
}

/** Build stale offer: stale_price warning, expiresAt set to a small offset from asOf */
export function buildStaleOffers(cfg: ScenarioConfig, count = 2): FlightOffer[] {
  // Set expiresAt to 60 seconds after asOf (technically valid per schema: expiresAt > retrievedAt)
  // The stale_price warning indicates the price may be outdated
  const expiresAt = addMs(cfg.asOf, 60_000); // 1 minute validity
  const { baseDepMs } = makeTimestamps(cfg.departureDate, cfg.asOf, cfg.offerValidityMs);
  const rands = prngSequence(`stale:${cfg.origin}:${cfg.destination}:${cfg.departureDate}`, cfg.seed, count * 3);
  return Array.from({ length: count }, (_, i) => {
    const ri = i * 3;
    const depMs = baseDepMs + Math.floor(rands[ri] * 4 * 3600_000);
    const arrMs = depMs + (120 + Math.floor(rands[ri + 1] * 240)) * 60_000;
    const carrier = syntheticCarrier(rands[ri + 2]);
    const id = syntheticOfferId(cfg.providerId, "stale", i);
    return FlightOfferSchema.parse({
      ...baseOffer(id, cfg.providerId, cfg.asOf, expiresAt, cfg.currency, String(18000 + i * 800)),
      id,
      journeys: [{
        segments: [{
          origin: cfg.origin, destination: cfg.destination,
          departureAt: new Date(depMs).toISOString(),
          arrivalAt: new Date(arrMs).toISOString(),
          marketingCarrier: carrier, marketingFlightNumber: "401",
          operatingCarrier: null, operatingFlightNumber: null, cabin: "economy",
        }],
      }],
      warnings: ["stale_price"],
    });
  });
}

/**
 * Build duplicate offers: 2 offers with identical operating carrier/number/times
 * so groupOffersByItinerary collapses them to one fingerprint group.
 */
export function buildDuplicateOffers(cfg: ScenarioConfig): FlightOffer[] {
  const { baseDepMs, expiresAt } = makeTimestamps(cfg.departureDate, cfg.asOf, cfg.offerValidityMs);
  const depMs = baseDepMs + 2 * 3600_000;
  const arrMs = depMs + 300 * 60_000; // 5h flight
  // Both offers have same schedule (same operating carrier/number/times)
  // but different prices and IDs — duplicates from different fare classes
  return [0, 1].map((i) => {
    const id = syntheticOfferId(cfg.providerId, "duplicate", i);
    return FlightOfferSchema.parse({
      ...baseOffer(id, cfg.providerId, cfg.asOf, expiresAt, cfg.currency, String(20000 + i * 5000)),
      id,
      journeys: [{
        segments: [{
          origin: cfg.origin, destination: cfg.destination,
          departureAt: new Date(depMs).toISOString(),
          arrivalAt: new Date(arrMs).toISOString(),
          marketingCarrier: "ZZ", marketingFlightNumber: "500",
          operatingCarrier: "ZZ", operatingFlightNumber: "500", // same operating → same fingerprint
          cabin: "economy",
        }],
      }],
      warnings: [],
    });
  });
}

export const MOCK_PROVIDER_CORPUS: Record<MockProviderScenario, (cfg: ScenarioConfig) => FlightOffer[]> = {
  nonstop: (cfg) => buildNonstopOffers(cfg),
  one_stop: (cfg) => buildOneStopOffers(cfg),
  codeshare: (cfg) => buildCodeshareOffers(cfg),
  airport_change: (cfg) => buildAirportChangeOffers(cfg),
  self_transfer: (cfg) => buildSelfTransferOffers(cfg),
  mixed_cabin: (cfg) => buildMixedCabinOffers(cfg),
  stale: (cfg) => buildStaleOffers(cfg),
  duplicate: (cfg) => buildDuplicateOffers(cfg),
  no_results: (_cfg) => [],
  provider_error: (_cfg) => { throw new ProviderErrorScenarioError("Synthetic provider error — scenario: provider_error"); },
  timeout: (_cfg) => { throw new Error("timeout scenario should not be called directly — handled by mock-provider.ts"); },
};

/** Named error thrown by provider_error scenario — allows runProvider to map it to status:"error". */
export class ProviderErrorScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderErrorScenarioError";
  }
}
