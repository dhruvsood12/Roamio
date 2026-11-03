// Deterministic primitives for synthetic FlightProvider data.
// No Date.now, Math.random, or fetch. All randomness comes from seeded splitmix32.

import { CURRENCY_METADATA_V1, type SupportedCurrencyCode } from "@flightbrain/domain";

export const SYNTHETIC_CARRIERS = ["ZZ", "ZY", "ZX", "ZW", "ZV"] as const;
export type SyntheticCarrier = typeof SYNTHETIC_CARRIERS[number];

/** FNV-1a 32-bit hash over a UTF-8 string. Deterministic, no external state. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    for (let byte = code; byte > 0; byte >>= 8) {
      hash ^= byte & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

/** Splitmix32 — one step. Returns [nextState, value in [0,1)]. */
export function splitmix32Step(state: number): [number, number] {
  state = (state + 0x9e3779b9) | 0;
  let z = state;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  z = z ^ (z >>> 16);
  const value = (z >>> 0) / 0x100000000;
  return [state >>> 0, value];
}

/** Derive a deterministic seed from a canonical string key + policy seed. */
export function deriveSeed(key: string, policySeed: number): number {
  return fnv1a32(JSON.stringify({ key, policySeed }));
}

/** Generate `count` pseudo-random values for a given key + policySeed. */
export function prngSequence(key: string, policySeed: number, count: number): number[] {
  let state = deriveSeed(key, policySeed);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const [nextState, value] = splitmix32Step(state);
    state = nextState;
    values.push(value);
  }
  return values;
}

/** Add milliseconds to an RFC 3339 timestamp. All timestamps stay UTC. */
export function addMs(timestamp: string, ms: number): string {
  const base = Date.parse(timestamp);
  return new Date(base + ms).toISOString();
}

export function syntheticCarrier(rand: number): SyntheticCarrier {
  return SYNTHETIC_CARRIERS[Math.floor(rand * SYNTHETIC_CARRIERS.length)];
}

export function syntheticFlightNumber(rand: number): string {
  return String(100 + Math.floor(rand * 900));
}

/** Build a deterministic offer ID from provider + scenario + offer index. */
export function syntheticOfferId(providerId: string, scenario: string, offerIndex: number): string {
  return `mock-offer-${fnv1a32(`${providerId}:${scenario}:${offerIndex}`).toString(16).padStart(8, "0")}`;
}

/** Return the exponent for a supported currency (from CURRENCY_METADATA_V1). */
export function exponentFor(currency: SupportedCurrencyCode): number {
  return CURRENCY_METADATA_V1.exponents[currency];
}
