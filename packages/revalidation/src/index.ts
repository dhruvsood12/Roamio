/**
 * C009 @flightbrain/revalidation — public barrel export.
 *
 * Leaf package above search-api. Must NOT be imported back by any existing package.
 */
export {
  RevalidationPolicySchema,
  FreshnessClassSchema,
  PriorResultSchema,
  ChangeCategorySchema,
  TripChangeSchema,
  RevalidationDiffSchema,
  RevalidationResultSchema,
  classifyTripFreshness,
  stableTripKey,
  revalidateSearch,
  type RevalidationPolicy,
  type FreshnessClass,
  type PriorResult,
  type ChangeCategory,
  type TripChange,
  type RevalidationDiff,
  type RevalidationResult,
  type RevalidationDeps,
} from "./revalidate";
