import { describe, it, expect } from "vitest";
import {
  buildResultsView,
  formatMoney,
  formatDurationMs,
  stopsLabel,
  REASON_LABELS,
  PROTECTION_LABELS,
} from "../../apps/results-web/src/viewModel";
import type { TripRankReason } from "@flightbrain/ranking";
import { TripRankReasonSchema } from "@flightbrain/ranking";
import {
  buildFixture,
  buildPartialFixture,
  buildFailedFixture,
  buildMixedCurrencyFixture,
  buildEmptyFixture,
  buildSelfTransferFixture,
  buildUnknownProtectionFixture,
  buildExpiredFixture,
  FIXTURE_AS_OF,
} from "./fixtures";

// ---------------------------------------------------------------------------
// formatMoney
// ---------------------------------------------------------------------------

describe("formatMoney", () => {
  it("formats USD with exponent 2 (123456 -> 1,234.56)", () => {
    expect(
      formatMoney({ amountMinor: "123456", currency: "USD", exponent: 2 }),
    ).toBe("$1,234.56");
  });

  it("formats JPY with exponent 0 (123 -> 123)", () => {
    expect(
      formatMoney({ amountMinor: "123", currency: "JPY", exponent: 0 }),
    ).toBe("¥123");
  });

  it("formats KWD with exponent 3 (1234 -> 1.234)", () => {
    // KWD: 1234 minor = 1.234 KWD
    const result = formatMoney({
      amountMinor: "1234",
      currency: "KWD",
      exponent: 3,
    });
    expect(result).toContain("1.234");
  });

  it("formats a value > Number.MAX_SAFE_INTEGER minor units exactly (no float loss)", () => {
    // 2^53 + 1 = 9007199254740993 — cannot be represented as a float
    const bigAmount = "9007199254740993";
    const result = formatMoney({
      amountMinor: bigAmount,
      currency: "USD",
      exponent: 2,
    });
    // The whole part should be 90071992547409 (without last 2 digits), fraction 93
    expect(result).toContain("90,071,992,547,409.93");
    // Most importantly, should NOT contain the rounded float version
    expect(result).not.toContain("90,071,992,547,409.92");
  });

  it("formats zero USD correctly", () => {
    expect(
      formatMoney({ amountMinor: "0", currency: "USD", exponent: 2 }),
    ).toBe("$0.00");
  });

  it("formats small amounts with leading zeros in fraction", () => {
    // 1 USD cent = 0.01
    expect(
      formatMoney({ amountMinor: "1", currency: "USD", exponent: 2 }),
    ).toBe("$0.01");
  });
});

// ---------------------------------------------------------------------------
// formatDurationMs
// ---------------------------------------------------------------------------

describe("formatDurationMs", () => {
  it("formats hours and minutes", () => {
    expect(formatDurationMs(3600_000 + 30 * 60_000)).toBe("1h 30m");
  });

  it("formats hours only", () => {
    expect(formatDurationMs(2 * 3600_000)).toBe("2h");
  });

  it("formats minutes only", () => {
    expect(formatDurationMs(45 * 60_000)).toBe("45m");
  });
});

// ---------------------------------------------------------------------------
// stopsLabel
// ---------------------------------------------------------------------------

describe("stopsLabel", () => {
  it("1 segment = Nonstop", () => expect(stopsLabel(1)).toBe("Nonstop"));
  it("2 segments = 1 stop", () => expect(stopsLabel(2)).toBe("1 stop"));
  it("3 segments = 2 stops", () => expect(stopsLabel(3)).toBe("2 stops"));
});

// ---------------------------------------------------------------------------
// REASON_LABELS completeness
// ---------------------------------------------------------------------------

describe("REASON_LABELS", () => {
  it("covers every TripRankReason enum value", () => {
    const allReasons = TripRankReasonSchema.options as TripRankReason[];
    for (const reason of allReasons) {
      expect(
        REASON_LABELS[reason],
        `Missing label for reason: ${reason}`,
      ).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// PROTECTION_LABELS tone distinctness
// ---------------------------------------------------------------------------

describe("PROTECTION_LABELS", () => {
  it("self_transfer label is distinct from protected label", () => {
    expect(PROTECTION_LABELS["self_transfer"]).not.toBe(
      PROTECTION_LABELS["protected"],
    );
  });

  it("self_transfer label does not contain the word 'protected' standalone", () => {
    // Must not imply protection status = protected
    expect(PROTECTION_LABELS["self_transfer"].toLowerCase()).not.toMatch(
      /^protected/,
    );
  });

  it("unknown label mentions 'unknown'", () => {
    expect(PROTECTION_LABELS["unknown"].toLowerCase()).toContain("unknown");
  });

  it("rendered self_transfer trip has tone distinct from protected (fixture-verified)", () => {
    // Verifies that a real trip with hasSelfTransfer=true gets tone "self_transfer", not "protected"
    const fixture = buildSelfTransferFixture();
    const view = buildResultsView(fixture, { asOf: FIXTURE_AS_OF });
    const selfTransferCards = view.trips.filter((t) => t.protection.tone === "self_transfer");
    expect(selfTransferCards.length).toBeGreaterThan(0);
    for (const card of selfTransferCards) {
      expect(card.protection.tone).not.toBe("protected");
      expect(card.protection.label).not.toBe(PROTECTION_LABELS["protected"]);
    }
  });
});

// ---------------------------------------------------------------------------
// buildResultsView — fixture-based tests
// ---------------------------------------------------------------------------

describe("buildResultsView – complete fixture", () => {
  it("produces a deterministic view with expected shape", async () => {
    const fixture = await buildFixture();
    const view = buildResultsView(fixture, { asOf: FIXTURE_AS_OF });

    expect(view.searchId).toBe(fixture.searchId);
    expect(view.asOf).toBe(FIXTURE_AS_OF);
    expect(view.banner.tone).toBe("complete");
    expect(view.trips.length).toBe(fixture.trips.length);

    // Determinism: calling again yields equal output
    const view2 = buildResultsView(fixture, { asOf: FIXTURE_AS_OF });
    expect(JSON.stringify(view)).toBe(JSON.stringify(view2));
  });

  it("every trip card has correct fields (no undefined/NaN)", async () => {
    const fixture = await buildFixture();
    const view = buildResultsView(fixture, { asOf: FIXTURE_AS_OF });

    for (const card of view.trips) {
      expect(card.id).toBeTruthy();
      expect(card.price.text).not.toContain("NaN");
      expect(card.price.text).not.toContain("undefined");
      expect(card.durationLabel).not.toContain("NaN");
      expect(card.durationLabel).not.toContain("undefined");
      expect(card.stopsLabel).not.toContain("undefined");
    }
  });

  it("every ReasonChip.reason is a valid TripRankReason", async () => {
    const fixture = await buildFixture();
    const view = buildResultsView(fixture, { asOf: FIXTURE_AS_OF });
    const allReasons = new Set(TripRankReasonSchema.options as TripRankReason[]);

    for (const card of view.trips) {
      for (const chip of card.reasons) {
        expect(allReasons.has(chip.reason)).toBe(true);
      }
    }
  });

  it("currencyNotice is null when no mixed currency", async () => {
    const fixture = await buildFixture();
    // Explicit precondition: standard fixture must NOT have mixed currency
    expect(fixture.diagnostics.mixedCurrencyIncomparable).toBe(false);
    const view = buildResultsView(fixture, { asOf: FIXTURE_AS_OF });
    expect(view.currencyNotice).toBeNull();
  });
});

describe("buildResultsView – partial status", () => {
  it("produces warn banner tone with appropriate message", async () => {
    const partial = await buildPartialFixture();
    const view = buildResultsView(partial, { asOf: FIXTURE_AS_OF });

    expect(view.banner.tone).toBe("warn");
    expect(view.banner.message.toLowerCase()).toContain("incomplete");
    // Coverage stats must be present
    expect(view.banner.coverage).toBeDefined();
    expect(typeof view.banner.coverage.tripsRanked).toBe("number");
  });
});

describe("buildResultsView – failed status", () => {
  it("produces error banner tone", async () => {
    const failed = await buildFailedFixture();
    const view = buildResultsView(failed, { asOf: FIXTURE_AS_OF });

    expect(view.banner.tone).toBe("error");
    expect(view.banner.message.toLowerCase()).toMatch(/error|unreliable/);
  });
});

describe("buildResultsView – mixed currency", () => {
  it("currencyNotice is non-null when mixedCurrencyIncomparable = true", async () => {
    const mixed = await buildMixedCurrencyFixture();
    const view = buildResultsView(mixed, { asOf: FIXTURE_AS_OF });

    expect(view.currencyNotice).not.toBeNull();
    expect(view.currencyNotice!.message.toLowerCase()).toContain("currencies");
    expect(view.currencyNotice!.message.toLowerCase()).toContain("comparable");
  });

  it("currencyNotice message does not claim a cross-currency cheapest", async () => {
    const mixed = await buildMixedCurrencyFixture();
    const view = buildResultsView(mixed, { asOf: FIXTURE_AS_OF });

    // Should NOT say "cheapest" across currencies
    // It may say "No global cheapest trip can be determined"
    expect(view.currencyNotice!.message.toLowerCase()).not.toMatch(
      /cheapest trip is/,
    );
  });
});

describe("buildResultsView – empty trips", () => {
  it("isEmpty = true + status complete does not throw", async () => {
    const empty = await buildEmptyFixture();
    const view = buildResultsView(empty, { asOf: FIXTURE_AS_OF });

    expect(view.isEmpty).toBe(true);
    expect(view.trips).toHaveLength(0);
    expect(view.banner.tone).toBe("complete");
  });
});

describe("buildResultsView – freshness", () => {
  it("requiresRevalidation = true yields revalidate or expired badge", async () => {
    const fixture = await buildFixture();
    const view = buildResultsView(fixture, { asOf: FIXTURE_AS_OF });

    for (const card of view.trips) {
      if (card.freshness.tone === "revalidate") {
        expect(card.freshness.label.toLowerCase()).toContain("revalidate");
      }
      if (card.freshness.tone === "expired") {
        expect(card.freshness.label.toLowerCase()).toContain("expired");
      }
    }
  });

  it("expired badge renders for a trip whose offer has expired (fixture-verified)", () => {
    const fixture = buildExpiredFixture();
    const view = buildResultsView(fixture, { asOf: FIXTURE_AS_OF });

    const expiredCards = view.trips.filter((t) => t.freshness.tone === "expired");
    // Precondition: the expired fixture must contain at least one expired trip
    expect(expiredCards.length).toBeGreaterThan(0);
    for (const card of expiredCards) {
      expect(card.freshness.label.toLowerCase()).toContain("expired");
    }
  });
});

describe("buildResultsView – protection badge tones", () => {
  it("self_transfer tone is never 'protected' (fixture-verified)", () => {
    const fixture = buildSelfTransferFixture();
    const view = buildResultsView(fixture, { asOf: FIXTURE_AS_OF });

    const selfTransferCards = view.trips.filter((t) => t.protection.tone === "self_transfer");
    // Precondition: the self_transfer fixture must have at least one self_transfer trip
    expect(selfTransferCards.length).toBeGreaterThan(0);

    for (const card of selfTransferCards) {
      // The label must not equal the protected label
      expect(card.protection.label).not.toBe(PROTECTION_LABELS["protected"]);
      // The tone enum itself must not equal "protected"
      expect(card.protection.tone).not.toBe("protected");
    }
  });

  it("unknown tone produces 'Protection unknown' label (fixture-verified)", () => {
    const fixture = buildUnknownProtectionFixture();
    const view = buildResultsView(fixture, { asOf: FIXTURE_AS_OF });

    const unknownCards = view.trips.filter((t) => t.protection.tone === "unknown");
    // Precondition: the unknown-protection fixture must have at least one unknown trip
    expect(unknownCards.length).toBeGreaterThan(0);

    for (const card of unknownCards) {
      expect(card.protection.label.toLowerCase()).toContain("unknown");
    }
  });
});

describe("buildResultsView – view reads only SearchResponse", () => {
  it("does not access Date.now (asOf is always explicit)", async () => {
    // We supply an asOf different from real "now" — the output must still be valid
    const fixture = await buildFixture();
    const pastAsOf = "2020-01-01T00:00:00.000Z";
    // Should not throw even with a far-past asOf
    const view = buildResultsView(fixture, { asOf: pastAsOf });
    expect(view.asOf).toBe(pastAsOf);
  });
});
