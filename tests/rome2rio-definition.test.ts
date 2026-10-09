import { describe, expect, it } from "vitest";
import { DiscoverySourceDefinitionSchema } from "@flightbrain/domain";
import { createRome2RioSourceDefinition } from "@flightbrain/discovery";

describe("Rome2Rio experimental source definition", () => {
  it("records an experiment without granting any independent usage right", () => {
    const source = createRome2RioSourceDefinition();
    expect(source).toMatchObject({ id: "rome2rio", accessMethod: "mcp", productionUse: {
      status: "experimental", reference: "rome2rio-connectivity-2026-10-06-v1",
    } });
    const rights = [...Object.values(source.persistencePolicy), ...Object.values(source.redistributionPolicy)];
    expect(rights).toHaveLength(5);
    for (const right of rights) expect(right).toEqual({ status: "unknown", reviewedAt: null, reference: null });
  });

  it("keeps unverified capabilities unknown rather than inferring them from tool names", () => {
    const { geography, ...capabilities } = createRome2RioSourceDefinition().capabilities;
    expect(geography).toEqual({ kind: "unknown" });
    expect(Object.values(capabilities).every(value => value === null)).toBe(true);
  });

  it("retains the unverified policy state across canonical JSON round trips", () => {
    const source = createRome2RioSourceDefinition();
    expect(DiscoverySourceDefinitionSchema.parse(JSON.parse(JSON.stringify(source)))).toEqual(source);
  });

  it("does not let a caller's policy or capability mutation change subsequent definitions", () => {
    const first = createRome2RioSourceDefinition();
    const original = structuredClone(first);
    first.productionUse.status = "approved";
    first.persistencePolicy.cache.status = "allowed";
    first.redistributionPolicy.displayToUser.status = "allowed";
    first.capabilities.schedules = true;
    expect(createRome2RioSourceDefinition()).toEqual(original);
  });
});
