// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../apps/tracker-web/src/App";
import {
  STORAGE,
  readFlights,
  remember,
  writeFlights,
} from "../../apps/tracker-web/src/storage";
import { createDemoProvider } from "../../apps/tracker-server/demo";
import { TrackerError } from "../../apps/tracker-server/provider";
import { QUERY, NOW, response } from "./helpers";

let root: Root, container: HTMLDivElement;
let requests: string[];
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
async function click(text: string) {
  const element = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text || b.textContent?.startsWith(text),
  );
  expect(element, `button ${text}`).toBeDefined();
  await act(async () => {
    element!.click();
  });
}
async function input(selector: string, value: string) {
  await act(async () => {
    const field = container.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function mount(path = "/") {
  history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  await flush();
}
beforeEach(() => {
  localStorage.clear();
  requests = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  const provider = createDemoProvider(() => Date.now());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      requests.push(url);
      if (url === "/api/health") return response(provider.health);
      const parsed = new URL(url, "http://localhost"),
        flightNumber = decodeURIComponent(parsed.pathname.split("/").pop()!);
      try {
        return response(
          await provider.search(
            { flightNumber, date: parsed.searchParams.get("date")! },
            options?.signal ?? new AbortController().signal,
          ),
        );
      } catch (error) {
        const e = error as TrackerError;
        return response(
          {
            error: {
              code: e.code,
              message: e.message,
              retryAfterSeconds: e.retryAfterSeconds,
            },
          },
          e.code === "flight_not_found"
            ? 404
            : e.code === "rate_limited"
              ? 429
              : 502,
        );
      }
    }),
  );
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("consumer tracker", () => {
  it("shows newly reported actual arrival on refresh", async () => {
    await mount("/flight/RM104/2026-11-01");
    const value = await createDemoProvider(() => NOW).search(
      QUERY,
      new AbortController().signal,
    );
    value.flights[0].actual.arrival = value.flights[0].estimated.arrival;
    value.flights[0].runway.landingAt = value.flights[0].estimated.arrival;
    value.flights[0].status = "arrived";
    vi.stubGlobal("fetch", async () => response(value));
    await click("Refresh");
    expect(container.querySelector(".status-label")?.textContent).toBe(
      "Arrived",
    );
    expect(container.textContent).toContain("Actual gate arrival");
  });
  it("preserves multiple matches with an explicit selector", async () => {
    const value = await createDemoProvider(() => NOW).search(
      QUERY,
      new AbortController().signal,
    );
    const second = structuredClone(value.flights[0]);
    second.id = "second";
    second.destination.airportCode = "BOS";
    value.flights.push(second);
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      url === "/api/health"
        ? original(url, init)
        : Promise.resolve(response(value)),
    );
    await mount("/flight/RM104/2026-11-01");
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Choose matching flight"]',
    )!;
    expect(select.options).toHaveLength(2);
    await act(async () => {
      select.value = "second";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector(".flight-route")?.textContent).toContain(
      "BOS",
    );
  });
  it("clears request deadlines even if a cancelled transport never settles", async () => {
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      url === "/api/health"
        ? original(url, init)
        : new Promise<Response>(() => {}),
    );
    await mount("/flight/RM104/2026-11-01");
    await act(async () => root.unmount());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("renders a labelled search and prominent demo disclosure", async () => {
    await mount();
    expect(container.textContent).toContain("Know your flight.");
    expect(container.textContent).toContain("DEMO DATA");
    expect(container.textContent).toContain("Not live flight information");
    expect(
      container.querySelector('label[for="flight-number"]'),
    ).not.toBeNull();
  });
  it("searches, renders flight status/timeline/map and updates deep link", async () => {
    await mount();
    await input("#flight-number", "rm 104");
    await click("Find my flight");
    expect(location.pathname).toBe("/flight/RM104/2026-11-01");
    expect(container.textContent).toContain("In the air");
    expect(container.textContent).toContain("Every moment, in view.");
    expect(
      container.querySelector('[aria-label="Latest aircraft position"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("35,000 ft");
    expect(container.textContent).not.toContain("undefined");
  });
  it("rejects malformed search without requesting it", async () => {
    await mount();
    await input("#flight-number", "123");
    await click("Find my flight");
    expect(container.textContent).toContain("Check the flight number");
    expect(requests.filter((r) => r.startsWith("/api/flights"))).toHaveLength(
      0,
    );
  });
  it("loads valid deep links directly", async () => {
    await mount("/flight/RM102/2026-11-01");
    expect(container.textContent).toContain("Delayed");
    expect(container.textContent).toContain("45 min late");
  });
  it("shows invalid URLs as an input error", async () => {
    await mount("/flight/%/2026-11-01");
    expect(container.textContent).toContain("flight link is invalid");
    expect(requests).toEqual(["/api/health"]);
  });
  it("offers useful not-found and unavailable states", async () => {
    await mount();
    await input("#flight-number", "RM404");
    await click("Find my flight");
    expect(container.textContent).toContain("No flight found for RM404");
    await input("#flight-number", "RM500");
    await click("Find my flight");
    expect(container.textContent).toContain("Flight updates are unavailable.");
    expect(container.textContent).toContain("Try again");
  });
  it("shows cancellation without fabricated progress", async () => {
    await mount("/flight/RM106/2026-11-01");
    expect(container.textContent).toContain("Cancelled");
    expect(container.textContent).toContain("Contact your airline");
    expect(container.textContent).not.toContain("Estimated gate arrival in");
  });
  it("preserves usable status without position", async () => {
    await mount("/flight/RM109/2026-11-01");
    expect(container.textContent).toContain("No aircraft position available");
    expect(container.textContent).toContain("Time-based estimate");
    expect(container.textContent).toContain("In the air");
  });
  it("renders missing gates without undefined", async () => {
    await mount("/flight/RM108/2026-11-01");
    expect(container.querySelector(".gate-grid")?.textContent).toContain("—");
    expect(container.textContent).not.toContain("undefined");
  });
  it("labels stale demo observations twice without claiming live", async () => {
    await mount("/flight/RM110/2026-11-01");
    expect(container.textContent).toContain("STALE DATA");
    expect(container.textContent).toContain("DEMO · STALE");
    expect(container.querySelector(".freshness.live")).toBeNull();
  });
  it("saves only identifiers, restores across remount and untracks", async () => {
    await mount("/flight/RM104/2026-11-01");
    await click("Track flight");
    expect(JSON.parse(localStorage.getItem(STORAGE.saved)!)).toEqual([QUERY]);
    await act(async () => root.unmount());
    container.remove();
    await mount("/");
    expect(container.querySelector(".saved-card")?.textContent).toContain(
      "RM104",
    );
    expect(container.querySelector(".saved-card")?.textContent).toContain(
      "In the air",
    );
    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="Untrack RM104"]',
    )!;
    await act(async () => remove.click());
    expect(readFlights("saved")).toEqual([]);
  });
  it("records bounded deduplicated recent searches", async () => {
    await mount("/flight/RM104/2026-11-01");
    await click("Delayed");
    await click("In air");
    expect(readFlights("recent")).toHaveLength(2);
    expect(readFlights("recent")[0].flightNumber).toBe("RM104");
  });
  it("refreshes automatically and pauses while hidden", async () => {
    await mount("/flight/RM104/2026-11-01");
    const initial = requests.length;
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(requests.length).toBe(initial + 1);
    expect(container.querySelector(".flight-footer")?.textContent).toContain(
      "just now",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(requests.length).toBe(initial + 1);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(requests.length).toBe(initial + 2);
  });
  it("keeps old observations stale after refresh failures", async () => {
    await mount("/flight/RM104/2026-11-01");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await click("Refresh");
    expect(container.textContent).toContain("STALE DATA");
    expect(container.textContent).toContain("last available observation");
    expect(container.textContent).toContain("SFO");
  });
  it("keeps the developer inspector collapsed", async () => {
    await mount("/flight/RM104/2026-11-01");
    expect(container.querySelector("details")?.open).toBe(false);
  });
  it("cleans up polling timers when unmounted", async () => {
    await mount("/flight/RM104/2026-11-01");
    await act(async () => root.unmount());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("handles localStorage write failure without breaking tracking", async () => {
    await mount("/flight/RM104/2026-11-01");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await click("Track flight");
    expect(container.textContent).toContain("couldn't save your flights");
    expect(container.textContent).toContain("In the air");
  });
  it("renders loading while flight lookup is pending", async () => {
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      url === "/api/health"
        ? original(url, init)
        : new Promise<Response>(() => {}),
    );
    await mount("/flight/RM104/2026-11-01");
    expect(
      container.querySelector('[aria-label="Loading flight"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("In the air");
  });
  it("aborts superseded requests and ignores their eventual results", async () => {
    const original = globalThis.fetch;
    let complete: ((response: Response) => void) | undefined;
    let aborted: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url.includes("/RM104?")) {
        aborted = init?.signal;
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      }
      return original(url, init);
    });
    await mount("/flight/RM104/2026-11-01");
    await click("Cancelled");
    expect(aborted?.aborted).toBe(true);
    const old = await createDemoProvider(() => NOW).search(
      QUERY,
      new AbortController().signal,
    );
    await act(async () => complete?.(response(old)));
    expect(container.querySelector(".flight-topline h2")?.textContent).toBe(
      "RM106",
    );
    expect(container.querySelector(".status-label")?.textContent).toBe(
      "Cancelled",
    );
  });
  it("does not overlap manual refresh with a pending request", async () => {
    await mount("/flight/RM104/2026-11-01");
    let count = 0;
    vi.stubGlobal("fetch", () => {
      count++;
      return new Promise<Response>(() => {});
    });
    await click("Refresh");
    await click("Updating…");
    expect(count).toBe(1);
  });
  it("isolates a stalled saved-flight lookup from the rest of the list", async () => {
    const delayed = { flightNumber: "RM102", date: "2026-11-01" };
    writeFlights("saved", [QUERY, delayed]); // RM104 first (stalls), RM102 second
    const provider = createDemoProvider(() => Date.now());
    const honorAbort = (
      signal: AbortSignal | null | undefined,
      reject: (reason: unknown) => void,
    ): boolean => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return true;
      }
      signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
      return false;
    };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url === "/api/health")
        return Promise.resolve(response(provider.health));
      if (url.includes("/RM104?"))
        // Never settles on its own; only its own deadline can abort it.
        return new Promise<Response>((_resolve, reject) =>
          honorAbort(init?.signal, reject),
        );
      // A fresh per-request controller lets this resolve; a shared,
      // already-aborted signal would reject here — the poisoning symptom.
      return new Promise<Response>((resolve, reject) => {
        if (honorAbort(init?.signal, reject)) return;
        const parsed = new URL(url, "http://localhost");
        void provider
          .search(
            {
              flightNumber: decodeURIComponent(
                parsed.pathname.split("/").pop()!,
              ),
              date: parsed.searchParams.get("date")!,
            },
            new AbortController().signal,
          )
          .then((result) => resolve(response(result)));
      });
    });
    await mount("/");
    const savedStatus = (flightNumber: string) =>
      [...container.querySelectorAll(".saved-card")]
        .find(
          (c) =>
            c.querySelector(".saved-ident b")?.textContent === flightNumber,
        )
        ?.querySelector(".saved-status")?.textContent ?? "";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(18_000);
    });
    await flush();
    expect(savedStatus("RM104")).toContain("UNAVAILABLE");
    expect(savedStatus("RM102")).not.toContain("UNAVAILABLE");
    expect(savedStatus("RM102")).toContain("Delayed");
  });
});
describe("local identifier storage", () => {
  it.each([
    "not json",
    "{}",
    "null",
    '[{"flightNumber":"bad","date":"bad"}]',
    "x".repeat(17000),
  ])("recovers from corrupted storage", (raw) => {
    localStorage.setItem(STORAGE.saved, raw);
    expect(readFlights("saved")).toEqual([]);
  });
  it("rejects metadata in stored identifiers", () => {
    localStorage.setItem(
      STORAGE.saved,
      JSON.stringify([{ ...QUERY, payload: { secret: true } }]),
    );
    expect(readFlights("saved")).toEqual([]);
  });
  it("deduplicates and bounds stored lists", () => {
    const values = Array.from({ length: 30 }, (_, i) => ({
      ...QUERY,
      flightNumber: `RM${i}`,
    }));
    localStorage.setItem(STORAGE.saved, JSON.stringify([...values, ...values]));
    expect(readFlights("saved")).toHaveLength(20);
    expect(remember([QUERY, QUERY], QUERY, 8)).toEqual([QUERY]);
  });
  it("rejects invalid writes", () =>
    expect(writeFlights("saved", [{ ...QUERY, date: "invalid" }])).toBe(false));
});
