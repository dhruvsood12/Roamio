import {
  DiscoverySourceDefinitionSchema, RouteDiscoveryRequestSchema, RouteDiscoveryResultSchema,
  type DiscoverySourceDefinition, type RouteDiscoveryCapabilities, type RouteDiscoveryRequest, type RouteDiscoveryResult,
} from "@flightbrain/domain";

// Execution-only context, never a canonical/public DTO. No credentials or clients.
export type RouteDiscoveryContext = { signal: AbortSignal; deadlineAt: string | null };

export interface RouteDiscoverySource {
  readonly id: string;
  readonly capabilities: RouteDiscoveryCapabilities;
  discover(request: RouteDiscoveryRequest, context: RouteDiscoveryContext): Promise<RouteDiscoveryResult>;
}

// Pure boundary validation, not a source runner or an authorization/legal engine.
export function validateRouteDiscoveryResult(
  raw: unknown, source: DiscoverySourceDefinition, request: RouteDiscoveryRequest,
): RouteDiscoveryResult {
  const definition = DiscoverySourceDefinitionSchema.parse(source);
  const intent = RouteDiscoveryRequestSchema.parse(request);
  const result = RouteDiscoveryResultSchema.parse(raw);
  if (result.sourceId !== definition.id || result.requestId !== intent.requestId) {
    throw new RangeError("Discovery result does not match the invoked source and request");
  }
  for (const candidate of result.candidates) {
    if ((candidate.source.kind === "heuristic") !== (definition.accessMethod === "heuristic")) {
      throw new RangeError("Candidate source kind does not match its registered access method");
    }
    const capabilities = definition.capabilities;
    if (capabilities.multimodal === false && new Set(candidate.legs.map(l => l.mode)).size > 1) {
      throw new RangeError("Source disclaims multimodal discovery");
    }
    for (const leg of candidate.legs) {
      if (capabilities.modes !== null && !capabilities.modes.includes(leg.mode)) {
        throw new RangeError("Candidate mode is outside declared source capabilities");
      }
      if (capabilities.schedules === false && leg.scheduleState !== "unknown") {
        throw new RangeError("Source disclaims schedule discovery");
      }
    }
    if (capabilities.estimatedPrices === false && (candidate.estimatedPrice !== null || candidate.legs.some(l => l.estimatedPrice !== null))) {
      throw new RangeError("Source disclaims price estimates");
    }
  }
  return result;
}
