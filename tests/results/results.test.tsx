// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ResultsApp } from "../../apps/results-web/src/components";
import { PROTECTION_LABELS } from "../../apps/results-web/src/viewModel";
import {
  buildFixture,
  buildPartialFixture,
  buildFailedFixture,
  buildMixedCurrencyFixture,
  buildEmptyFixture,
  buildSelfTransferFixture,
  buildExpiredFixture,
  FIXTURE_AS_OF,
} from "./fixtures";
import type { SearchResponse } from "@flightbrain/search-api";

let root: Root;
let container: HTMLDivElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let errorSpy: ReturnType<typeof vi.spyOn<any, any>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let warnSpy: ReturnType<typeof vi.spyOn<any, any>>;

async function mount(response: SearchResponse, asOf = FIXTURE_AS_OF) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ResultsApp response={response} asOf={asOf} />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Basic render
// ---------------------------------------------------------------------------

describe("ResultsApp – basic render", () => {
  it("renders deterministically with no console errors or warnings", async () => {
    const fixture = await buildFixture();
    await mount(fixture);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("undefined");
    expect(container.textContent).not.toContain("NaN");
  });

  it("renders the same output on remount (deterministic)", async () => {
    const fixture = await buildFixture();
    await mount(fixture);
    const html1 = container.innerHTML;

    await act(async () => root.unmount());
    container.remove();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ResultsApp response={fixture} asOf={FIXTURE_AS_OF} />);
    });
    const html2 = container.innerHTML;

    expect(html1).toBe(html2);
  });

  it("renders expected prices (non-empty text, no NaN/undefined)", async () => {
    const fixture = await buildFixture();
    await mount(fixture);

    if (fixture.trips.length > 0) {
      // At least one price must be visible
      const priceTags = container.querySelectorAll(".price-tag");
      expect(priceTags.length).toBeGreaterThan(0);
      for (const tag of priceTags) {
        expect(tag.textContent).not.toContain("NaN");
        expect(tag.textContent).not.toContain("undefined");
        expect(tag.textContent!.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage banner
// ---------------------------------------------------------------------------

describe("ResultsApp – coverage banner", () => {
  it("partial banner has role=status", async () => {
    const partial = await buildPartialFixture();
    await mount(partial);

    const banner = container.querySelector(".coverage-banner");
    expect(banner).not.toBeNull();
    // partial tone → role=status
    const role = banner!.getAttribute("role");
    expect(role).toBe("status");
    expect(container.textContent).toContain("incomplete");
  });

  it("failed banner has role=alert", async () => {
    const failed = await buildFailedFixture();
    await mount(failed);

    const banner = container.querySelector(".coverage-banner");
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("role")).toBe("alert");
  });

  it("complete banner is present", async () => {
    const fixture = await buildFixture();
    await mount(fixture);

    const banner = container.querySelector(".coverage-banner");
    expect(banner).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Self-transfer / protection distinctness
// ---------------------------------------------------------------------------

describe("ResultsApp – protection rendering", () => {
  it("self_transfer badge is in a distinct CSS class from protected", async () => {
    const fixture = buildSelfTransferFixture();
    await mount(fixture);

    const selfTransferTags = container.querySelectorAll(
      ".protection-tag--self_transfer",
    );

    // Precondition: the fixture must actually contain self_transfer trips
    expect(selfTransferTags.length).toBeGreaterThan(0);

    // Any self_transfer tag must NOT also carry the protected class
    for (const tag of selfTransferTags) {
      expect(tag.classList.contains("protection-tag--protected")).toBe(false);
    }
    // And no self_transfer tag text equals the protected label
    for (const tag of selfTransferTags) {
      expect(tag.textContent).not.toBe(PROTECTION_LABELS["protected"]);
    }
  });

  it("self_transfer text contains appropriate disclosure", async () => {
    const fixture = buildSelfTransferFixture();
    await mount(fixture);

    const selfTransferTags = container.querySelectorAll(
      ".protection-tag--self_transfer",
    );

    // Precondition: the fixture must actually contain self_transfer trips
    expect(selfTransferTags.length).toBeGreaterThan(0);

    for (const tag of selfTransferTags) {
      const text = tag.textContent?.toLowerCase() ?? "";
      // Must contain "self-transfer" or "separate" to disclose the risk
      expect(text).toMatch(/self-transfer|separate/);
    }
  });
});

// ---------------------------------------------------------------------------
// Freshness badges
// ---------------------------------------------------------------------------

describe("ResultsApp – freshness badges", () => {
  it("revalidate badge renders when present", async () => {
    const fixture = await buildFixture();
    await mount(fixture);

    const revalidateTags = container.querySelectorAll(
      ".freshness-tag--revalidate",
    );
    for (const tag of revalidateTags) {
      expect(tag.textContent?.toLowerCase()).toContain("revalidate");
    }
  });

  it("expired badge renders when present", async () => {
    const fixture = buildExpiredFixture();
    await mount(fixture);

    const expiredTags = container.querySelectorAll(".freshness-tag--expired");

    // Precondition: the fixture must contain at least one expired trip
    expect(expiredTags.length).toBeGreaterThan(0);

    for (const tag of expiredTags) {
      expect(tag.textContent?.toLowerCase()).toContain("expired");
    }
  });
});

// ---------------------------------------------------------------------------
// Currency notice
// ---------------------------------------------------------------------------

describe("ResultsApp – currency notice", () => {
  it("renders currency notice for mixedCurrencyIncomparable", async () => {
    const mixed = await buildMixedCurrencyFixture();
    await mount(mixed);

    const notice = container.querySelector(".currency-notice");
    expect(notice).not.toBeNull();
    expect(notice!.textContent?.toLowerCase()).toContain("currencies");
    expect(notice!.textContent?.toLowerCase()).toContain("comparable");
  });

  it("does not render currency notice for single-currency result", async () => {
    const fixture = await buildFixture();
    // Explicit precondition: the standard fixture must NOT have mixed currency
    expect(fixture.diagnostics.mixedCurrencyIncomparable).toBe(false);
    await mount(fixture);
    const notice = container.querySelector(".currency-notice");
    expect(notice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty results
// ---------------------------------------------------------------------------

describe("ResultsApp – empty results", () => {
  it("renders EmptyResults when trips = [] and status = complete", async () => {
    const empty = await buildEmptyFixture();
    await mount(empty);

    expect(container.textContent).toContain("No matching trips");
    // Should not error or render "undefined"
    expect(errorSpy).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("undefined");
  });

  it("does not render a TripList when empty", async () => {
    const empty = await buildEmptyFixture();
    await mount(empty);

    const tripCards = container.querySelectorAll(".trip-card");
    expect(tripCards.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe("ResultsApp – accessibility", () => {
  it("coverage banner has accessible role", async () => {
    const fixture = await buildFixture();
    await mount(fixture);

    const banner = container.querySelector(".coverage-banner");
    expect(banner).not.toBeNull();
    const role = banner!.getAttribute("role");
    expect(["status", "alert"]).toContain(role);
  });

  it("currency notice has accessible role", async () => {
    const mixed = await buildMixedCurrencyFixture();
    await mount(mixed);

    const notice = container.querySelector(".currency-notice");
    if (notice) {
      const role = notice.getAttribute("role");
      expect(role).toBeTruthy();
    }
  });

  it("trip cards have accessible labels", async () => {
    const fixture = await buildFixture();
    await mount(fixture);

    const cards = container.querySelectorAll(".trip-card");
    for (const card of cards) {
      const label = card.getAttribute("aria-label");
      expect(label).toBeTruthy();
    }
  });

  it("price tags have accessible labels", async () => {
    const fixture = await buildFixture();
    await mount(fixture);

    const priceTags = container.querySelectorAll(".price-tag");
    for (const tag of priceTags) {
      const label = tag.getAttribute("aria-label");
      expect(label).toBeTruthy();
      expect(label).not.toContain("undefined");
    }
  });

  it("protection tags have accessible labels", async () => {
    const fixture = await buildFixture();
    await mount(fixture);

    const tags = container.querySelectorAll(".protection-tag");
    for (const tag of tags) {
      const label = tag.getAttribute("aria-label");
      expect(label).toBeTruthy();
    }
  });
});
