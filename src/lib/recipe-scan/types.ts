// Recipe Scan: the shapes shared by extraction, matching and the review draft.
// `DraftData` is stored as JSON on `RecipeScanDraft.data`, so everything here
// must stay plain JSON (no Dates, Maps, undefined-only fields that matter).
import type { MethodStep } from '@/lib/recipe-method'

/** MATCHED = ready; CHECK = linked but the amount needs a look; NO_MATCH = no item yet; NO_AMOUNT = "to taste". */
export type LineStatus = 'MATCHED' | 'CHECK' | 'NO_MATCH' | 'NO_AMOUNT'

/** One ingredient line exactly as the reader found it. */
export interface ExtractedIngredient {
  raw: string
  qty: number | null
  unit: string | null
  name: string
  /** The reader's own guess at the WHOLE line in a measurable unit (e.g. 3 cloves ≈ 15 g). */
  estimate?: { qty: number; unit: string } | null
}

export interface ExtractedStep {
  text: string
  phase: string
  minutes: number | null
  minutesStated: boolean
  waitMinutes: number | null
  waitNote: string | null
  waitStated: boolean
}

export interface ExtractedRecipe {
  name: string
  yieldQty: number | null
  yieldUnit: string | null
  categoryHint: string | null
  ingredients: ExtractedIngredient[]
  steps: ExtractedStep[]
}

export interface DraftLine {
  key: string
  raw: string
  name: string
  /** As written, e.g. "3 cloves". */
  qtyText: string
  /** What will be saved (canonical unit) when linked. */
  qty: number | null
  unit: string | null
  link: { kind: 'item' | 'recipe'; id: string; name: string } | null
  status: LineStatus
  /** e.g. "3 cloves — how much is a clove?" */
  reason: string | null
  /** Only for unlinked lines; null = not chosen yet. */
  allergens: string[] | null
  createdItem?: boolean
}

export interface DraftData {
  name: string
  yieldQty: number | null
  yieldUnit: string | null
  yieldGuessed: boolean
  categoryId: string | null
  revenueCenterId: string | null
  lines: DraftLine[]
  method: MethodStep[]
  /** Keyed by MethodStep.key. */
  guessed: Record<string, { minutes?: true; wait?: true }>
  /** Line key -> sibling draft title, e.g. "Aioli is in this scan — save it first". */
  siblingHints: Record<string, string>
}
