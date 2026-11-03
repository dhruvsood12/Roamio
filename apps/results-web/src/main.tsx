/**
 * C008 results-web — main entry point for browser bundle.
 * Response + asOf are injected via window.__RESULTS_DATA__ in production.
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";

declare global {
  interface Window {
    __RESULTS_DATA__?: { response: unknown; asOf: string; locale?: string };
  }
}

const container = document.getElementById("root");
if (container) {
  const data = window.__RESULTS_DATA__;
  if (!data) {
    container.textContent = "No results data provided.";
  } else {
    const root = createRoot(container);
    root.render(
      <App
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response={data.response as any}
        asOf={data.asOf}
        locale={data.locale}
      />,
    );
  }
}
