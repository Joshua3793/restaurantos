import type { PrepPriority } from '@/lib/prep-utils'
import type { RecipeStage, StageEvent } from '@/lib/prep-stages'
import type { MethodStep } from '@/lib/recipe-method'
import type { RestInfo, PipelineInfo } from '@/lib/prep-plan'
import type { CadenceStats } from '@/lib/prep-cadence'

export type { PrepPriority }

export type PrepStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'PARTIAL'
  | 'BLOCKED'
  | 'SKIPPED'

export interface PrepLogData {
  id: string
  prepItemId: string
  logDate: string
  status: PrepStatus
  requiredQty: number | null
  actualPrepQty: number | null
  assignedTo: string | null
  dueTime: string | null
  note: string | null
  blockedReason: string | null
  inventoryAdjusted: boolean
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  /** Chef's order within a priority bucket (Smart Prep v2 draft). */
  listOrder: number | null
  /** Set when the chef posts the list — membership in the kitchen's To Do. */
  postedAt: string | null
  /** Staged prep — index into the recipe's chain; null/undefined when not staged. */
  stageIndex?: number | null
  /** When the current stage began (ISO instant). */
  stageEnteredAt?: string | null
  /** Append-only StageEvent[] (a correction is recorded, not erased). */
  stageHistory?: StageEvent[] | null
}

/** Header row for a posted prep list (PrepPost) — the To Do provenance band. */
export interface PrepPostInfo {
  id: string
  postedAt: string
  postedByName: string
  itemCount: number
  activeMinutes: number
  dirty: boolean
  /** The day the list was posted for. Often NOT today: the kitchen posts the next
   *  day's list at the end of a shift and its jobs carry over until they're done. */
  listDate?: string
}

export interface PrepItemRich {
  id: string
  name: string
  category: string
  station: string | null
  parLevel: number
  unit: string
  minThreshold: number
  targetToday: number | null
  shelfLifeDays: number | null
  estimatedPrepTime: number | null
  notes: string | null
  manualPriorityOverride: string | null
  isActive: boolean
  isOnList: boolean
  linkedRecipeId: string | null
  linkedRecipe: {
    id: string
    name: string
    yieldUnit: string
    baseYieldQty: number
    /** The resolved stage chain, or null when the recipe is unstaged. */
    stages?: RecipeStage[] | null
  } | null
  linkedInventoryItemId: string | null
  onHand: number
  priority: PrepPriority
  suggestedQty: number
  isBlocked: boolean
  blockedReason: string | null
  todayLog: PrepLogData | null
  createdAt: string
  updatedAt: string
  ingredientShortCount: number | null
  ingredientTotalCount: number | null
  lastMadeAt: string | null
  revenueCenterId: string | null
  activeMinutes: number | null
  passiveMinutes: number | null
  passiveNote: string | null
  /** The item's target service — ACTIVE only. The API nulls this when the service
   *  has been soft-removed, so no surface can name a service that no longer exists.
   *  `startByMinutes` still anchors on the stored time either way. */
  service: { id: string; name: string; timeMinutes: number; endMinutes: number | null } | null
  startByMinutes: number | null
  /** The step's deadline for the day (minute-of-day, ≥1440 ⇒ tomorrow). Attached
   *  on the run sheet by `withLadderTimes`; absent on API payloads. */
  deadlineMinutes?: number | null
  /** A staged job resting in an unattended stage — attached by `withLadderTimes`
   *  on the run sheet (null = hands-on or unstaged); absent on API payloads. */
  rest?: RestInfo | null
  /** A job in flight (any live IN_PROGRESS log) — planner evidence, never a stock credit. */
  pipeline?: PipelineInfo | null
  /** The make history over the last 60 days (see prep-cadence.ts). */
  cadence?: CadenceStats | null
  assignedCook: { id: string; initials: string; name: string; homeStation: string | null } | null
  /** RAW item-level overrides — what the edit form binds to. Distinct from the
   *  resolved `activeMinutes`/`passiveMinutes`/`passiveNote` above, which fall back
   *  to the linked recipe. Null here means "inherit from the recipe". */
  targetServiceId: string | null
  activeMinutesOverride: number | null
  passiveMinutesOverride: number | null
  passiveNoteOverride: string | null
}

export interface IngredientAvailability {
  id: string
  inventoryItemId: string | null
  /** Set when this ingredient is itself a sub-recipe (e.g. Custard) — links to its recipe. */
  linkedRecipeId: string | null
  itemName: string
  qtyBase: number
  unit: string
  stockOnHand: number | null
  isAvailable: boolean | null
}

export interface RecipeStepsData {
  id: string
  name: string
  /** Plain instruction lines — derived from `method` when one exists (kept for readers that only want text). */
  steps: string[]
  /** One Method, with waits — the cook-along groups it by phase and lights the current block. */
  method?: MethodStep[] | null
  /** The resolved chain (null/undefined = unstaged) — the drawer lists it with the current stage lit. */
  stages?: RecipeStage[] | null
  baseYieldQty: number
  yieldUnit: string
  totalCost: number
  /** RecipeIngredient id marked as the baker's 100% reference (null when unset).
   *  Matches `IngredientAvailability.id` — both are RecipeIngredient ids. */
  baseIngredientId: string | null
}

export interface PrepItemDetail extends PrepItemRich {
  ingredients: IngredientAvailability[]
}

export interface LinkedItemSummary {
  id: string
  itemName: string
}

export interface PrepTask {
  id: string
  name: string
  revenueCenterId: string
  linkedInventoryItemId: string | null
  sortOrder: number
  isActive: boolean
  linkedInventoryItem: LinkedItemSummary | null
}

export interface PrepTaskTodayLog {
  id: string
  prepTaskId: string
  logDate: string
}

// A library task plus whether it is on today's list (active).
export interface PrepTaskRow extends PrepTask {
  activeToday: boolean
}
