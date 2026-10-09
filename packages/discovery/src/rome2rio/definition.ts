import { DiscoverySourceDefinitionSchema, type DiscoverySourceDefinition } from "@flightbrain/domain";

// Metadata only: no callable adapter or usage permission is established here.
// The technical review record is in docs/ROME2RIO_ADAPTER.md.
export function createRome2RioSourceDefinition(): DiscoverySourceDefinition {
  return DiscoverySourceDefinitionSchema.parse({
    id: "rome2rio",
    name: "Rome2Rio",
    accessMethod: "mcp",
    capabilities: {
      modes: null, multimodal: null, dateFiltering: null, schedules: null,
      estimatedPrices: null, realtime: null, geography: { kind: "unknown" },
    },
    productionUse: {
      status: "experimental",
      reviewedAt: "2026-10-06T03:32:40Z",
      reference: "rome2rio-connectivity-2026-10-06-v1",
    },
    // Every action defaults independently to unknown, with no approval reference.
    persistencePolicy: {},
    redistributionPolicy: {},
  });
}
