import {
  DiscoverySourceDefinitionSchema, RouteDiscoveryRequestSchema, RouteDiscoveryResultSchema, TimestampSchema,
  type DiscoverySourceDefinition, type RouteDiscoveryRequest, type RouteDiscoveryResult,
} from "@flightbrain/domain";
import type { RouteDiscoveryContext, RouteDiscoverySource } from "../index";
import { createRome2RioSourceDefinition } from "./definition";

// Roamio intent, NOT the native get-routes parameter schema. A future authorized
// transport must translate it using verified tool schemas and unwrap MCP envelopes.
export interface Rome2RioClient {
  getRoutes(request: RouteDiscoveryRequest, context: RouteDiscoveryContext): Promise<unknown>;
}

export type Rome2RioFailureCode = "access_denied" | "quota_limited" | "source_unavailable" | "timeout" | "cancelled";
export class Rome2RioClientError extends Error {
  constructor(readonly code: Rome2RioFailureCode) {
    super("Rome2Rio client failed");
    this.name = "Rome2RioClientError";
  }
}

// This scaffold deliberately has no native payload parser. A fulfilled client call
// cannot become empty success, candidates, or schedule/price evidence by assumption.
export class Rome2RioDiscoverySource implements RouteDiscoverySource {
  readonly id = "rome2rio";
  readonly mappingStatus = "blocked_schema_discovery" as const;
  private readonly definition: DiscoverySourceDefinition;

  constructor(private readonly client: Rome2RioClient, definition = createRome2RioSourceDefinition()) {
    this.definition = DiscoverySourceDefinitionSchema.parse(definition);
    if (this.definition.id !== this.id || this.definition.accessMethod !== "mcp") {
      throw new RangeError("Expected a Rome2Rio MCP source definition");
    }
  }

  get capabilities() {
    return structuredClone(this.definition.capabilities);
  }

  async discover(rawRequest: RouteDiscoveryRequest, context: RouteDiscoveryContext): Promise<RouteDiscoveryResult> {
    const request = RouteDiscoveryRequestSchema.parse(rawRequest);
    const startedAt = new Date().toISOString();
    // Local adapter-attempt times only; rollback may collapse the interval to zero.
    const getFinishedAt = (): RouteDiscoveryResult["finishedAt"] => {
      const observed = new Date().toISOString();
      return Date.parse(observed) >= Date.parse(startedAt) ? observed : startedAt;
    };
    const finish = (status: RouteDiscoveryResult["status"], diagnostic: RouteDiscoveryResult["diagnostics"][number]) =>
      RouteDiscoveryResultSchema.parse({
        kind: "route_discovery_result", sourceId: this.id, requestId: request.requestId,
        startedAt, finishedAt: getFinishedAt(), status, candidates: [], diagnostics: [diagnostic],
      });

    if (context.signal.aborted) return finish("error", "cancelled");
    const deadline = context.deadlineAt === null ? null : TimestampSchema.safeParse(context.deadlineAt);
    if (deadline !== null && !deadline.success) return finish("error", "unsupported_request");
    const remaining = deadline?.success ? Date.parse(deadline.data) - Date.now() : null;
    if (remaining !== null && remaining <= 0) return finish("timeout", "deadline_exceeded");
    // setTimeout cannot safely represent delays beyond a signed 32-bit integer.
    if (remaining !== null && remaining > 2_147_483_647) return finish("error", "unsupported_request");
    if (!["experimental", "approved"].includes(this.definition.productionUse.status) ||
      this.definition.persistencePolicy.transientUse.status !== "allowed") {
      return finish("error", "access_denied");
    }

    const controller = new AbortController();
    let stopped: "timeout" | "cancelled" | null = null;
    let rejectStopped: (error: Rome2RioClientError) => void = () => {};
    const stopPromise = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const stop = (code: "timeout" | "cancelled") => {
      if (stopped !== null) return;
      stopped = code;
      controller.abort();
      rejectStopped(new Rome2RioClientError(code));
    };
    const cancel = () => stop("cancelled");
    context.signal.addEventListener("abort", cancel, { once: true });
    const timer = remaining === null ? null : setTimeout(() => stop("timeout"), remaining);
    try {
      // Clone again so an injected client cannot mutate result provenance or input.
      const response = Promise.resolve().then(() => {
        if (context.signal.aborted) cancel();
        if (stopped !== null) throw new Rome2RioClientError(stopped);
        return this.client.getRoutes(structuredClone(request), { signal: controller.signal, deadlineAt: context.deadlineAt });
      });
      await Promise.race([response, stopPromise]);
      // No JSON serialization, property access, guessing or raw data in diagnostics.
      return finish("error", "source_unavailable");
    } catch (error: unknown) {
      const code = stopped ?? (error instanceof Rome2RioClientError ? error.code : null);
      if (code === "timeout") return finish("timeout", "deadline_exceeded");
      if (code === "cancelled") return finish("error", "cancelled");
      if (code === "access_denied" || code === "quota_limited" || code === "source_unavailable") return finish("error", code);
      return finish("error", "internal_error");
    } finally {
      if (timer !== null) clearTimeout(timer);
      context.signal.removeEventListener("abort", cancel);
    }
  }
}
