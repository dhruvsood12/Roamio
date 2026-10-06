import { z } from "zod";
import { AirportCodeSchema, DateSchema, DurationMinutesSchema, MarketCodeSchema, TimestampSchema } from "./flights";
import { MoneySchema } from "./money";

const TextSchema = z.string().min(1).max(256).refine(
  value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value),
  "Expected unpadded text without control characters",
);
const IdSchema = TextSchema;
const IndexSchema = z.number().int().nonnegative();
const SourceIdSchema = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/);

export const TransportModeSchema = z.enum(["flight", "rail", "bus", "ferry", "car", "rideshare", "walk", "other"]);
export type TransportMode = z.infer<typeof TransportModeSchema>;
const ModesSchema = z.array(TransportModeSchema).min(1).refine(v => new Set(v).size === v.length, "Modes must be unique");

// Only public source-native identifiers belong here, never authentication/session IDs.
// The namespace is explicit; an opaque ID never becomes global location identity.
export const DiscoveryNativeRefSchema = z.strictObject({ sourceId: SourceIdSchema, id: IdSchema });
export type DiscoveryNativeRef = z.infer<typeof DiscoveryNativeRefSchema>;
export const CoordinatesSchema = z.strictObject({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
});
const hubShape = { reference: DiscoveryNativeRefSchema, name: TextSchema.nullable(), coordinates: CoordinatesSchema.nullable() };
const areaShape = { name: TextSchema, countryCode: MarketCodeSchema.nullable(), reference: DiscoveryNativeRefSchema.nullable() };
export const LocationRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("airport"), iataCode: AirportCodeSchema }),
  z.strictObject({ kind: z.literal("rail_station"), ...hubShape }),
  z.strictObject({ kind: z.literal("bus_station"), ...hubShape }),
  z.strictObject({ kind: z.literal("ferry_terminal"), ...hubShape }),
  z.strictObject({ kind: z.literal("other_hub"), ...hubShape }),
  z.strictObject({ kind: z.literal("city"), ...areaShape }),
  z.strictObject({ kind: z.literal("metro_area"), ...areaShape }),
  z.strictObject({ kind: z.literal("point"), coordinates: CoordinatesSchema }),
  z.strictObject({ kind: z.literal("address"), address: TextSchema, countryCode: MarketCodeSchema.nullable() }),
]);
export type LocationRef = z.infer<typeof LocationRefSchema>;

const DepartureIntentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unspecified") }),
  z.strictObject({ kind: z.literal("date"), date: DateSchema }),
  z.strictObject({ kind: z.literal("window"), startAt: TimestampSchema, endAt: TimestampSchema })
    .refine(v => Date.parse(v.endAt) > Date.parse(v.startAt), "Departure window end must follow start"),
]);
export const RouteDiscoveryRequestSchema = z.strictObject({
  requestId: IdSchema, origin: LocationRefSchema, destination: LocationRefSchema,
  departure: DepartureIntentSchema,
  allowedModes: ModesSchema.nullable(), maxIntermediateStops: IndexSchema.nullable(),
  // A party count is optional discovery context, not commercial passenger eligibility.
  passengers: z.strictObject({ count: z.number().int().positive() }).nullable(),
});
export type RouteDiscoveryRequest = z.infer<typeof RouteDiscoveryRequestSchema>;

export const RouteDiscoveryCapabilitiesSchema = z.strictObject({
  modes: ModesSchema.nullable(), multimodal: z.boolean().nullable(),
  dateFiltering: z.boolean().nullable(), schedules: z.boolean().nullable(),
  estimatedPrices: z.boolean().nullable(), realtime: z.boolean().nullable(),
  geography: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unknown") }),
    z.strictObject({ kind: z.literal("global") }),
    z.strictObject({ kind: z.literal("countries"), countries: z.array(MarketCodeSchema).min(1)
      .refine(v => new Set(v).size === v.length, "Countries must be unique") }),
  ]),
}).refine(v => v.multimodal !== true || v.modes === null || v.modes.length > 1,
  "Multimodal support cannot declare just one supported mode");
export type RouteDiscoveryCapabilities = z.infer<typeof RouteDiscoveryCapabilitiesSchema>;

export const EstimatedPriceSchema = z.strictObject({
  kind: z.literal("estimate"), amount: MoneySchema,
  // No assumption that a displayed estimate covers the requested party.
  basis: z.enum(["per_person", "whole_party", "unknown"]),
});
export type EstimatedPrice = z.infer<typeof EstimatedPriceSchema>;

export const RouteFactTypeSchema = z.enum([
  "route_exists", "schedule", "duration", "estimated_price", "operator", "service_identity", "transfer", "availability_hint",
]);
export type RouteFactType = z.infer<typeof RouteFactTypeSchema>;
// Quoted/revalidated commercial facts belong beyond this discovery boundary.
export const DiscoveryEvidenceLevelSchema = z.enum(["hint", "estimated", "scheduled", "observed"]);
export type DiscoveryEvidenceLevel = z.infer<typeof DiscoveryEvidenceLevelSchema>;
const EvidenceTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("candidate") }),
  z.strictObject({ kind: z.literal("leg"), legIndex: IndexSchema }),
]);
const evidenceShape = {
  target: EvidenceTargetSchema, sourceId: SourceIdSchema,
  observedAt: TimestampSchema.nullable(), expiresAt: TimestampSchema.nullable(),
  sourceReference: z.strictObject({ kind: z.enum(["route", "schedule", "service", "dataset", "rule"]), id: IdSchema }).nullable(),
};
export const RouteEvidenceSchema = z.discriminatedUnion("factType", [
  z.strictObject({ ...evidenceShape, factType: z.literal("route_exists"), level: z.enum(["hint", "scheduled", "observed"]) }),
  z.strictObject({ ...evidenceShape, factType: z.literal("schedule"), level: z.enum(["estimated", "scheduled", "observed"]) }),
  z.strictObject({ ...evidenceShape, factType: z.literal("duration"), level: z.enum(["estimated", "scheduled", "observed"]) }),
  z.strictObject({ ...evidenceShape, factType: z.literal("estimated_price"), level: z.literal("estimated") }),
  z.strictObject({ ...evidenceShape, factType: z.literal("operator"), level: z.enum(["hint", "scheduled", "observed"]) }),
  z.strictObject({ ...evidenceShape, factType: z.literal("service_identity"), level: z.enum(["hint", "scheduled", "observed"]) }),
  z.strictObject({ ...evidenceShape, factType: z.literal("transfer"), level: z.enum(["hint", "scheduled", "observed"]) }),
  z.strictObject({ ...evidenceShape, factType: z.literal("availability_hint"), level: z.enum(["hint", "observed"]) }),
]);
export type RouteEvidence = z.infer<typeof RouteEvidenceSchema>;

const OperatorSchema = z.strictObject({ name: TextSchema.nullable(), reference: DiscoveryNativeRefSchema.nullable() })
  .refine(v => v.name !== null || v.reference !== null, "Use null when the operator is unknown");
export const RouteCandidateLegSchema = z.strictObject({
  order: IndexSchema, origin: LocationRefSchema, destination: LocationRefSchema, mode: TransportModeSchema,
  // A transfer is a role of a movement, not another mode or a protection claim.
  role: z.enum(["travel", "transfer"]),
  operator: OperatorSchema.nullable(), serviceRef: DiscoveryNativeRefSchema.nullable(),
  scheduleState: z.enum(["unknown", "estimated", "scheduled", "observed"]),
  departureAt: TimestampSchema.nullable(), arrivalAt: TimestampSchema.nullable(),
  estimatedDurationMinutes: DurationMinutesSchema.nullable(), estimatedPrice: EstimatedPriceSchema.nullable(),
}).superRefine((leg, ctx) => {
  if ((leg.scheduleState === "unknown") !== (leg.departureAt === null && leg.arrivalAt === null)) {
    ctx.addIssue({ code: "custom", path: ["scheduleState"], message: "Unknown schedule requires null instants; known schedule requires at least one instant" });
  }
  if (leg.departureAt !== null && leg.arrivalAt !== null && Date.parse(leg.arrivalAt) <= Date.parse(leg.departureAt)) {
    ctx.addIssue({ code: "custom", path: ["arrivalAt"], message: "Known arrival must follow departure" });
  }
});
export type RouteCandidateLeg = z.infer<typeof RouteCandidateLegSchema>;

export const RouteSourceRefSchema = z.strictObject({
  sourceId: SourceIdSchema, kind: z.enum(["external", "heuristic"]), externalRouteId: IdSchema.nullable(),
});
export type RouteSourceRef = z.infer<typeof RouteSourceRefSchema>;
const CandidateBaseSchema = z.strictObject({
  kind: z.literal("route_candidate"), id: IdSchema, requestId: IdSchema,
  source: RouteSourceRefSchema, discoveredAt: TimestampSchema,
  legs: z.tuple([RouteCandidateLegSchema]).rest(RouteCandidateLegSchema),
  evidence: z.array(RouteEvidenceSchema).min(1),
  estimatedDurationMinutes: DurationMinutesSchema.nullable(), estimatedPrice: EstimatedPriceSchema.nullable(),
});
export const RouteCandidateSchema = CandidateBaseSchema.superRefine((candidate, ctx) => {
  if (!CandidateBaseSchema.safeParse(candidate).success) return;
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const matches = (fact: RouteEvidence, type: RouteFactType, legIndex: number | null) =>
    fact.factType === type && (legIndex === null ? fact.target.kind === "candidate"
      : fact.target.kind === "leg" && fact.target.legIndex === legIndex);
  const requireEvidence = (type: RouteFactType, legIndex: number | null) => {
    if (!candidate.evidence.some(e => matches(e, type, legIndex))) {
      issue(["evidence"], `Missing ${type} evidence for ${legIndex === null ? "candidate" : `leg ${legIndex}`}`);
    }
  };
  let latestKnownInstant: number | null = null;
  candidate.legs.forEach((leg, index) => {
    if (leg.order !== index) issue(["legs", index, "order"], "Leg order must equal its array position");
    requireEvidence("route_exists", index);
    if (leg.scheduleState !== "unknown") requireEvidence("schedule", index);
    if (leg.operator !== null) requireEvidence("operator", index);
    if (leg.serviceRef !== null) requireEvidence("service_identity", index);
    if (leg.role === "transfer") requireEvidence("transfer", index);
    if (leg.estimatedDurationMinutes !== null) requireEvidence("duration", index);
    if (leg.estimatedPrice !== null) requireEvidence("estimated_price", index);
    // Missing events do not erase ordering constraints between supplied instants.
    for (const field of ["departureAt", "arrivalAt"] as const) {
      const timestamp = leg[field];
      if (timestamp === null) continue;
      const instant = Date.parse(timestamp);
      if (latestKnownInstant !== null && instant < latestKnownInstant) {
        issue(["legs", index, field], "Known route times cannot reverse chronology");
      } else {
        latestKnownInstant = instant;
      }
    }
  });
  if (candidate.estimatedDurationMinutes !== null) requireEvidence("duration", null);
  if (candidate.estimatedPrice !== null) requireEvidence("estimated_price", null);
  candidate.evidence.forEach((fact, index) => {
    const path = ["evidence", index];
    if (fact.sourceId !== candidate.source.sourceId) issue(path, "Evidence must belong to this source observation");
    if (candidate.source.kind === "heuristic" && fact.level !== "hint") issue(path, "Heuristic evidence must remain a hint");
    const leg = fact.target.kind === "leg" ? candidate.legs[fact.target.legIndex] : null;
    if (fact.target.kind === "leg" && !leg) { issue(path, "Evidence targets a missing leg"); return; }
    switch (fact.factType) {
      case "schedule":
        if (!leg || leg.scheduleState !== fact.level) issue(path, "Schedule evidence must match the targeted leg's known schedule state");
        break;
      case "duration":
        if ((leg ?? candidate).estimatedDurationMinutes === null) issue(path, "Duration evidence needs a value at its target");
        break;
      case "estimated_price":
        if ((leg ?? candidate).estimatedPrice === null) issue(path, "Price evidence needs an estimate at its target");
        break;
      case "operator":
        if (!leg || leg.operator === null) issue(path, "Operator evidence needs a known leg operator");
        break;
      case "service_identity":
        if (!leg || leg.serviceRef === null) issue(path, "Service evidence needs a known leg service reference");
        break;
      case "transfer":
        if (!leg || leg.role !== "transfer") issue(path, "Transfer evidence must target a transfer leg");
        break;
    }
  });
});
export type RouteCandidate = z.infer<typeof RouteCandidateSchema>;

const reviewShape = { reviewedAt: TimestampSchema.nullable().default(null), reference: IdSchema.nullable().default(null) };
export const DiscoveryPermissionSchema = z.strictObject({
  status: z.enum(["allowed", "denied", "unknown"]).default("unknown"), ...reviewShape,
}).superRefine((permission, ctx) => {
  if (permission.status !== "unknown" && (permission.reviewedAt === null || permission.reference === null)) {
    ctx.addIssue({ code: "custom", message: "A known permission decision requires an attributed review" });
  }
});
export type DiscoveryPermission = z.infer<typeof DiscoveryPermissionSchema>;
const PermissionSchema = DiscoveryPermissionSchema.default({ status: "unknown", reviewedAt: null, reference: null });
export const ProductionUseStatusSchema = z.enum(["approved", "experimental", "unknown", "restricted", "disabled"]);
export type ProductionUseStatus = z.infer<typeof ProductionUseStatusSchema>;
export const DiscoverySourceDefinitionSchema = z.strictObject({
  id: SourceIdSchema, name: TextSchema,
  accessMethod: z.enum(["mcp", "api", "gtfs", "gtfs_realtime", "open_data", "heuristic", "other"]),
  capabilities: RouteDiscoveryCapabilitiesSchema,
  productionUse: z.strictObject({ status: ProductionUseStatusSchema.default("unknown"), ...reviewShape })
    .refine(v => v.status !== "approved" || (v.reviewedAt !== null && v.reference !== null), "Approval requires an attributed review")
    .default({ status: "unknown", reviewedAt: null, reference: null }),
  persistencePolicy: z.strictObject({ transientUse: PermissionSchema, cache: PermissionSchema, persist: PermissionSchema })
    .prefault({}),
  redistributionPolicy: z.strictObject({ displayToUser: PermissionSchema, redistribute: PermissionSchema }).prefault({}),
});
export type DiscoverySourceDefinition = z.infer<typeof DiscoverySourceDefinitionSchema>;

export const RouteDiscoveryDiagnosticSchema = z.enum([
  "unsupported_request", "invalid_candidate", "quota_limited", "truncated", "deadline_exceeded",
  "cancelled", "source_unavailable", "access_denied", "internal_error",
]);
const ResultBaseSchema = z.strictObject({
  kind: z.literal("route_discovery_result"), requestId: IdSchema, sourceId: SourceIdSchema,
  candidates: z.array(RouteCandidateSchema), startedAt: TimestampSchema, finishedAt: TimestampSchema,
  status: z.enum(["success", "partial", "timeout", "error"]),
  diagnostics: z.array(RouteDiscoveryDiagnosticSchema).default([]),
});
export const RouteDiscoveryResultSchema = ResultBaseSchema.superRefine((result, ctx) => {
  if (!ResultBaseSchema.safeParse(result).success) return;
  if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
    ctx.addIssue({ code: "custom", path: ["finishedAt"], message: "Completion cannot precede start" });
  }
  const ids = new Set<string>();
  result.candidates.forEach((candidate, index) => {
    if (candidate.source.sourceId !== result.sourceId || candidate.requestId !== result.requestId) {
      ctx.addIssue({ code: "custom", path: ["candidates", index], message: "Candidate source and request must match the result" });
    }
    if (ids.has(candidate.id)) ctx.addIssue({ code: "custom", path: ["candidates", index, "id"], message: "Candidate occurrence IDs must be unique within this result" });
    ids.add(candidate.id);
  });
  // Execution state never discards already accepted, independently validated hints.
});
export type RouteDiscoveryResult = z.infer<typeof RouteDiscoveryResultSchema>;
