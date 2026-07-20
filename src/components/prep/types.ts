import type { PrepPriority } from '@/lib/prep-utils'

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
  steps: string[]
  baseYieldQty: number
  yieldUnit: string
  totalCost: number
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
