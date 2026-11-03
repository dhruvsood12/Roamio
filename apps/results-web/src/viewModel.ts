/**
 * C008 results-web — pure view-model transform.
 * No Date.now(), no fetch, no wall clock — asOf is always injected.
 */

import type { SearchResponse, RankedTripResult, SearchCoverage } from "@flightbrain/search-api";
import type { TripRankReason } from "@flightbrain/ranking";
import type { Money } from "@flightbrain/domain";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PriceLabelKind = "cash" | "points" | "incomparable";

export interface PriceLabel {
  kind: PriceLabelKind;
  /** Formatted display string */
  text: string;
  currency?: string;
}

export type ProtectionBadgeTone = "protected" | "self_transfer" | "unknown";

export interface ProtectionBadge {
  tone: ProtectionBadgeTone;
  label: string;
}

export type FreshnessBadgeTone = "revalidate" | "expired" | "fresh";

export interface FreshnessBadge {
  tone: FreshnessBadgeTone;
  label: string;
}

export interface ReasonChip {
  reason: TripRankReason;
  label: string;
}

export interface SourceOfferLine {
  provider: string;
  retrievedAt: string;
  expiresAt: string | null;
  requiresRevalidation: boolean;
}

export interface TripCardView {
  id: string;
  price: PriceLabel;
  durationLabel: string;
  stopsLabel: string;
  protection: ProtectionBadge;
  freshness: FreshnessBadge;
  reasons: ReasonChip[];
  sourceOffers: SourceOfferLine[];
  fullyFeasible: boolean;
}

export type CoverageBannerTone = "complete" | "warn" | "error";

export interface CoverageBannerView {
  tone: CoverageBannerTone;
  message: string;
  coverage: SearchCoverage;
}

export interface CurrencyNoticeView {
  message: string;
}

export interface ResultsView {
  searchId: string;
  asOf: string;
  banner: CoverageBannerView;
  currencyNotice: CurrencyNoticeView | null;
  trips: TripCardView[];
  isEmpty: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REASON_LABELS: Record<TripRankReason, string> = {
  lowest_cash_price: "Lowest price",
  fastest_itinerary: "Fastest",
  fewest_stops: "Fewest stops",
  single_booking_component: "Single booking",
  fully_protected_connections: "All connections protected",
  contains_self_transfer: "Self-transfer / separate tickets",
  unknown_connection_protection: "Connection protection unknown",
  requires_revalidation: "Requires revalidation",
  offer_expired: "Offer expired",
  price_incomparable_currency: "Price not directly comparable",
};

export const PROTECTION_LABELS: Record<ProtectionBadgeTone, string> = {
  protected: "Protected connection",
  self_transfer: "Self-transfer / separate tickets — not a protected connection",
  unknown: "Protection unknown",
};

const COVERAGE_MESSAGES: Record<"complete" | "partial" | "failed", string> = {
  complete: "All providers searched successfully.",
  partial: "Some providers could not be reached — results may be incomplete.",
  failed: "Search encountered an error — results may be unreliable.",
};

// ---------------------------------------------------------------------------
// formatMoney — BigInt/string-slice only, NEVER parseFloat/Number(amountMinor)
// ---------------------------------------------------------------------------

export function formatMoney(money: Money, locale?: string): string {
  const { amountMinor, currency, exponent } = money;
  // Split amountMinor string at the decimal point using string slicing.
  const len = amountMinor.length;
  let whole: string;
  let fraction: string;
  if (exponent === 0) {
    whole = amountMinor;
    fraction = "";
  } else {
    if (len <= exponent) {
      whole = "0";
      fraction = amountMinor.padStart(exponent, "0");
    } else {
      whole = amountMinor.slice(0, len - exponent);
      fraction = amountMinor.slice(len - exponent);
    }
  }

  // Format the integer (whole) part with locale-aware thousands separators
  // using BigInt so we never lose precision for values > Number.MAX_SAFE_INTEGER.
  const wholeInt = BigInt(whole);
  // Intl.NumberFormat can format BigInt directly (ES2020+)
  const loc = locale ?? "en-US";
  const intFormatted = new Intl.NumberFormat(loc, {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    useGrouping: true,
  }).format(wholeInt);

  const full = exponent > 0 ? `${intFormatted}.${fraction}` : intFormatted;

  // Prepend the currency symbol/code.
  const symbolFormatter = new Intl.NumberFormat(loc, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    useGrouping: false,
  });
  // Extract just the symbol/prefix by formatting 0 and stripping the number.
  const zeroParts = symbolFormatter.formatToParts(0);
  const symbolPart = zeroParts.find((p) => p.type === "currency")?.value ?? currency;
  const literalBefore = zeroParts
    .slice(0, zeroParts.findIndex((p) => p.type === "currency") + 1)
    .filter((p) => p.type === "literal")
    .map((p) => p.value)
    .join("");
  const literalAfter = zeroParts
    .slice(zeroParts.findIndex((p) => p.type === "currency") + 1)
    .filter((p) => p.type === "literal")
    .map((p) => p.value)
    .join("");
  const numberIndex = zeroParts.findIndex((p) => p.type === "integer");
  const currencyIndex = zeroParts.findIndex((p) => p.type === "currency");

  if (numberIndex < currencyIndex) {
    // Symbol after number: e.g. some locales
    return `${full}${literalAfter}${symbolPart}`;
  }
  // Symbol before number (most common for USD, EUR, GBP)
  return `${symbolPart}${literalBefore}${full}`;
}

// ---------------------------------------------------------------------------
// formatDurationMs
// ---------------------------------------------------------------------------

export function formatDurationMs(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

// ---------------------------------------------------------------------------
// stopsLabel
// ---------------------------------------------------------------------------

export function stopsLabel(segmentCount: number): string {
  if (segmentCount <= 1) return "Nonstop";
  const stops = segmentCount - 1;
  return stops === 1 ? "1 stop" : `${stops} stops`;
}

// ---------------------------------------------------------------------------
// buildResultsView — the main pure transform
// ---------------------------------------------------------------------------

export function buildResultsView(
  response: SearchResponse,
  options: { asOf: string; locale?: string },
): ResultsView {
  const { asOf, locale } = options;

  // Coverage banner
  const bannerTone: CoverageBannerTone =
    response.status === "failed"
      ? "error"
      : response.status === "partial"
        ? "warn"
        : "complete";

  const banner: CoverageBannerView = {
    tone: bannerTone,
    message: COVERAGE_MESSAGES[response.status],
    coverage: response.coverage,
  };

  // Currency notice
  const currencyNotice: CurrencyNoticeView | null =
    response.diagnostics.mixedCurrencyIncomparable
      ? {
          message:
            "Shown in different currencies — not directly comparable. No global cheapest trip can be determined.",
        }
      : null;

  // Trip cards
  const trips: TripCardView[] = response.trips.map((ranked) =>
    buildTripCardView(ranked, asOf, locale),
  );

  return {
    searchId: response.searchId,
    asOf,
    banner,
    currencyNotice,
    trips,
    isEmpty: trips.length === 0,
  };
}

function buildTripCardView(
  ranked: RankedTripResult,
  asOf: string,
  locale?: string,
): TripCardView {
  const { trip, metrics, reasons, freshness, hasSelfTransfer, hasUnknownProtection } = ranked;

  // Price label
  const price = buildPriceLabel(trip.payment, locale);

  // Duration + stops
  const durationLabel = formatDurationMs(metrics.durationMilliseconds);
  const stops = stopsLabel(metrics.segmentCount);

  // Protection badge — self_transfer is DISTINCT from protected, never merged
  let protection: ProtectionBadge;
  if (hasSelfTransfer) {
    protection = {
      tone: "self_transfer",
      label: PROTECTION_LABELS["self_transfer"],
    };
  } else if (hasUnknownProtection) {
    protection = {
      tone: "unknown",
      label: PROTECTION_LABELS["unknown"],
    };
  } else {
    protection = {
      tone: "protected",
      label: PROTECTION_LABELS["protected"],
    };
  }

  // Freshness badge
  const freshnessBadge = buildFreshnessBadge(freshness, asOf);

  // Reason chips
  const reasonChips: ReasonChip[] = reasons.map((r) => ({
    reason: r,
    label: REASON_LABELS[r],
  }));

  // Source offer lines (safe TripSourceSnapshot fields only)
  const sourceOffers: SourceOfferLine[] = trip.sourceOffers.map((src) => ({
    provider: src.provider,
    retrievedAt: src.retrievedAt,
    expiresAt: src.expiresAt ?? null,
    requiresRevalidation: src.requiresRevalidation,
  }));

  return {
    id: trip.id,
    price,
    durationLabel,
    stopsLabel: stops,
    protection,
    freshness: freshnessBadge,
    reasons: reasonChips,
    sourceOffers,
    fullyFeasible: ranked.fullyFeasible,
  };
}

function buildPriceLabel(
  payment: RankedTripResult["trip"]["payment"],
  locale?: string,
): PriceLabel {
  const { cashByCurrency, pointsByProgram } = payment;

  if (pointsByProgram.length > 0 && cashByCurrency.length === 0) {
    // Points only
    const totalPoints = pointsByProgram.map((p) => `${p.points} pts`).join(" + ");
    return { kind: "points", text: totalPoints };
  }

  if (cashByCurrency.length === 0) {
    return { kind: "incomparable", text: "Price unavailable" };
  }

  if (cashByCurrency.length > 1 || pointsByProgram.length > 0) {
    // Mixed or multi-currency — incomparable
    const parts = cashByCurrency.map((m) => formatMoney(m, locale));
    if (pointsByProgram.length > 0) {
      parts.push(...pointsByProgram.map((p) => `${p.points} pts`));
    }
    return {
      kind: "incomparable",
      text: parts.join(" + "),
      currency: undefined,
    };
  }

  // Single cash currency
  const money = cashByCurrency[0];
  return {
    kind: "cash",
    text: formatMoney(money, locale),
    currency: money.currency,
  };
}

function buildFreshnessBadge(
  freshness: RankedTripResult["freshness"],
  asOf: string,
): FreshnessBadge {
  if (freshness.requiresRevalidation) {
    // Check whether any offer has actually expired (expiresAt <= asOf) vs just requiresRevalidation flag
    const asOfMs = Date.parse(asOf);
    const isExpired =
      freshness.nearestExpiresAt !== null &&
      Date.parse(freshness.nearestExpiresAt) <= asOfMs;

    if (isExpired) {
      return { tone: "expired", label: "Offer expired" };
    }
    return { tone: "revalidate", label: "Revalidate before booking" };
  }
  return { tone: "fresh", label: "Fresh" };
}
