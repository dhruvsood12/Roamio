/**
 * C015 @flightbrain/watch — public barrel export.
 *
 * Leaf package above revalidation. Must NOT be imported back by any existing package.
 */
export {
  WatchCriteriaSchema,
  WatchDefinitionSchema,
  WatchTriggerSchema,
  WatchTriggerHitSchema,
  WatchBestSchema,
  WatchUpdateSchema,
  evaluateWatch,
  type WatchCriteria,
  type WatchDefinition,
  type WatchTrigger,
  type WatchTriggerHit,
  type WatchBest,
  type WatchUpdate,
  type WatchDeps,
} from "./watch";
