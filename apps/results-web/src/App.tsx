/**
 * C008 results-web — App entry point.
 * Accepts a SearchResponse + asOf via props (no fetch, no live wiring here).
 */

import type { SearchResponse } from "@flightbrain/search-api";
import { ResultsApp } from "./components";

export interface AppProps {
  response: SearchResponse;
  asOf: string;
  locale?: string;
}

export function App({ response, asOf, locale }: AppProps) {
  return <ResultsApp response={response} asOf={asOf} locale={locale} />;
}
