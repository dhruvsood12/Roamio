/**
 * C008 results-web — React components.
 * Pure render from ResultsView; no fetch, no wall clock.
 */

import type { ReactNode } from "react";
import type {
  ResultsView,
  CoverageBannerView,
  CurrencyNoticeView,
  TripCardView,
  PriceLabel,
  ProtectionBadge,
  FreshnessBadge,
  ReasonChip,
  SourceOfferLine,
} from "./viewModel";
import { buildResultsView } from "./viewModel";
import type { SearchResponse } from "@flightbrain/search-api";

// ---------------------------------------------------------------------------
// CoverageBanner
// ---------------------------------------------------------------------------

export function CoverageBanner({ banner }: { banner: CoverageBannerView }) {
  const role = banner.tone === "error" ? "alert" : "status";
  const c = banner.coverage;
  return (
    <div
      className={`coverage-banner coverage-banner--${banner.tone}`}
      role={role}
      aria-live={banner.tone === "error" ? "assertive" : "polite"}
    >
      <span className="coverage-banner__message">{banner.message}</span>
      <ul className="coverage-banner__stats" aria-label="Search coverage">
        <li>Candidates discovered: {c.candidatesDiscovered}</li>
        <li>Jobs planned: {c.jobsPlanned}</li>
        <li>Jobs admitted: {c.jobsAdmitted}</li>
        <li>Offers received: {c.intakeOffered}</li>
        <li>Offers declined: {c.intakeDeclined}</li>
        <li>Trips composed: {c.tripsComposed}</li>
        <li>Trips ranked: {c.tripsRanked}</li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CurrencyNotice
// ---------------------------------------------------------------------------

export function CurrencyNotice({ notice }: { notice: CurrencyNoticeView }) {
  return (
    <div className="currency-notice" role="note" aria-label="Currency comparison notice">
      {notice.message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PriceTag
// ---------------------------------------------------------------------------

export function PriceTag({ price }: { price: PriceLabel }) {
  return (
    <span
      className={`price-tag price-tag--${price.kind}`}
      aria-label={`Price: ${price.text}`}
    >
      {price.text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ProtectionTag
// ---------------------------------------------------------------------------

export function ProtectionTag({ badge }: { badge: ProtectionBadge }) {
  return (
    <span
      className={`protection-tag protection-tag--${badge.tone}`}
      aria-label={`Connection protection: ${badge.label}`}
    >
      {badge.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// FreshnessTag
// ---------------------------------------------------------------------------

export function FreshnessTag({ badge }: { badge: FreshnessBadge }) {
  return (
    <span
      className={`freshness-tag freshness-tag--${badge.tone}`}
      aria-label={`Freshness: ${badge.label}`}
    >
      {badge.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ReasonList
// ---------------------------------------------------------------------------

export function ReasonList({ reasons }: { reasons: ReasonChip[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="reason-list" aria-label="Ranking reasons">
      {reasons.map((chip) => (
        <li
          key={chip.reason}
          className={`reason-chip reason-chip--${chip.reason}`}
          data-reason={chip.reason}
        >
          {chip.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// SourceOfferLine
// ---------------------------------------------------------------------------

export function SourceOfferLineItem({ offer }: { offer: SourceOfferLine }) {
  return (
    <li className="source-offer-line">
      <span className="source-offer-line__provider">{offer.provider}</span>
      <span className="source-offer-line__retrieved">
        Retrieved: {offer.retrievedAt}
      </span>
      {offer.expiresAt && (
        <span className="source-offer-line__expires">
          Expires: {offer.expiresAt}
        </span>
      )}
      {offer.requiresRevalidation && (
        <span className="source-offer-line__revalidate">Revalidation required</span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// TripCard
// ---------------------------------------------------------------------------

export function TripCard({ card }: { card: TripCardView }) {
  return (
    <article
      className="trip-card"
      aria-label={`Trip ${card.id}`}
      data-trip-id={card.id}
    >
      <div className="trip-card__header">
        <PriceTag price={card.price} />
        <span className="trip-card__duration" aria-label={`Duration: ${card.durationLabel}`}>
          {card.durationLabel}
        </span>
        <span className="trip-card__stops" aria-label={`Stops: ${card.stopsLabel}`}>
          {card.stopsLabel}
        </span>
      </div>
      <div className="trip-card__badges">
        <ProtectionTag badge={card.protection} />
        <FreshnessTag badge={card.freshness} />
      </div>
      <ReasonList reasons={card.reasons} />
      <ul className="trip-card__sources" aria-label="Source offers">
        {card.sourceOffers.map((offer, i) => (
          <SourceOfferLineItem key={i} offer={offer} />
        ))}
      </ul>
    </article>
  );
}

// ---------------------------------------------------------------------------
// TripList
// ---------------------------------------------------------------------------

export function TripList({ trips }: { trips: TripCardView[] }) {
  return (
    <section className="trip-list" aria-label="Ranked trips">
      <ol className="trip-list__items">
        {trips.map((card) => (
          <li key={card.id} className="trip-list__item">
            <TripCard card={card} />
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// EmptyResults
// ---------------------------------------------------------------------------

export function EmptyResults() {
  return (
    <div className="empty-results" role="status" aria-label="No results">
      No matching trips found for your search.
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResultsApp
// ---------------------------------------------------------------------------

export interface ResultsAppProps {
  response: SearchResponse;
  asOf: string;
  locale?: string;
}

export function ResultsApp({ response, asOf, locale }: ResultsAppProps) {
  const view: ResultsView = buildResultsView(response, { asOf, locale });

  return (
    <div className="results-app">
      <CoverageBanner banner={view.banner} />
      {view.currencyNotice && <CurrencyNotice notice={view.currencyNotice} />}
      {view.isEmpty ? (
        <EmptyResults />
      ) : (
        <TripList trips={view.trips} />
      )}
    </div>
  );
}
