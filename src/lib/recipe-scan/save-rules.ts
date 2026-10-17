// Recipe Scan: the pure rules behind saving a draft — what still blocks the
// save, the ingredient rows the recipe gets, and what the app learns from the
// chef's choices. No database here; the save route feeds it and writes the result.
import { normaliseAliasText } from '@/lib/alias-text'
import { UNIT_FACTORS, canonicalUom } from '@/lib/uom'
import { parseQty, singular } from './amount'
import { readQtyText } from './build-draft'
import type { DraftData, DraftLine } from './types'

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** Why this draft cannot be saved yet, in the chef's words. [] = it can. */
export function saveBlockers(d: DraftData, existingNames: string[]): string[] {
  const out: string[] = []
  const name = (d.name ?? '').trim()
  if (!name) out.push('Add a name')

  const checks = d.lines.filter(l => l.status === 'CHECK').length
  if (checks > 0) out.push(`${checks} ${plural(checks, 'line needs', 'lines need')} a check`)

  const yieldOk = typeof d.yieldQty === 'number' && Number.isFinite(d.yieldQty) && d.yieldQty > 0
    && typeof d.yieldUnit === 'string' && d.yieldUnit.trim() !== ''
  if (!yieldOk) out.push('Add the yield')

  if (!d.categoryId) out.push('Pick a category')

  const unchosen = d.lines.filter(l => l.link === null && l.allergens === null).length
  if (unchosen > 0) out.push(`Choose allergens for ${unchosen} unlinked ${plural(unchosen, 'line', 'lines')}`)

  if (name) {
    const lower = name.toLowerCase()
    if (existingNames.some(n => n.trim().toLowerCase() === lower)) {
      out.push(`A recipe called ${name} already exists`)
    }
  }
  return out
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function isLine(v: unknown): v is DraftLine {
  if (!isObj(v)) return false
  if (!isStr(v.key) || !isStr(v.name) || !isStr(v.raw) || !isStr(v.qtyText) || !isStr(v.status)) return false
  if (v.qty !== null && typeof v.qty !== 'number') return false
  if (v.unit !== null && !isStr(v.unit)) return false
  if (v.link !== null) {
    if (!isObj(v.link)) return false
    if ((v.link.kind !== 'item' && v.link.kind !== 'recipe') || !isStr(v.link.id) || !isStr(v.link.name)) return false
  }
  if (v.allergens !== null && !(Array.isArray(v.allergens) && v.allergens.every(isStr))) return false
  return true
}

/** Minimal shape check for a draft coming back from the browser. */
export function isDraftData(v: unknown): v is DraftData {
  if (!isObj(v)) return false
  if (!isStr(v.name)) return false
  if (!Array.isArray(v.lines) || !v.lines.every(isLine)) return false
  if (!Array.isArray(v.method)) return false
  if (v.yieldQty !== null && typeof v.yieldQty !== 'number') return false
  if (v.yieldUnit !== null && !isStr(v.yieldUnit)) return false
  if (v.categoryId !== null && !isStr(v.categoryId)) return false
  if (v.revenueCenterId !== null && v.revenueCenterId !== undefined && !isStr(v.revenueCenterId)) return false
  if (v.guessed !== undefined && !isObj(v.guessed)) return false
  if (v.siblingHints !== undefined && !isObj(v.siblingHints)) return false
  return true
}

export interface IngredientRow {
  inventoryItemId: string | null
  linkedRecipeId: string | null
  customName: string | null
  qtyBase: number
  unit: string
  allergens: string[]
  notes: string
  sortOrder: number
}

/** "3 cloves" → 3 + "cloves"; "to taste" → null + "to taste". */
function splitQtyText(qtyText: string): { count: number | null; word: string } {
  const text = (qtyText ?? '').trim()
  const { qty, unit } = readQtyText(text)
  if (qty === null && unit === null) {
    // No leading amount ("to taste", "a pinch"): keep every word.
    return { count: parseQty(text), word: text }
  }
  return { count: qty, word: unit ?? '' }
}

/**
 * The recipe's ingredient rows. A linked line saves its link and amount (no
 * amount = 0); `baseUnitOf` supplies the linked thing's own unit when the line
 * has none. An unlinked line keeps its words exactly: the name, the number off
 * the page, the rest of the amount as its unit, and the chef's allergens.
 */
export function ingredientRows(d: DraftData, baseUnitOf: (l: DraftLine) => string | null): IngredientRow[] {
  return d.lines.map((l, i): IngredientRow => {
    if (l.link) {
      return {
        inventoryItemId: l.link.kind === 'item' ? l.link.id : null,
        linkedRecipeId: l.link.kind === 'recipe' ? l.link.id : null,
        customName: null,
        qtyBase: typeof l.qty === 'number' && Number.isFinite(l.qty) && l.qty > 0 ? l.qty : 0,
        unit: l.unit || baseUnitOf(l) || '',
        allergens: [],
        notes: l.raw,
        sortOrder: i,
      }
    }
    const { count, word } = splitQtyText(l.qtyText)
    return {
      inventoryItemId: null,
      linkedRecipeId: null,
      customName: l.name.trim() || l.raw.trim(),
      qtyBase: count ?? 0,
      unit: word,
      allergens: l.allergens ?? [],
      notes: l.raw,
      sortOrder: i,
    }
  })
}

/** Wording → item/recipe for every linked line whose words differ from the thing's own name. */
export function aliasLearnings(d: DraftData): { text: string; kind: 'item' | 'recipe'; id: string }[] {
  const out = new Map<string, { text: string; kind: 'item' | 'recipe'; id: string }>()
  for (const l of d.lines) {
    if (!l.link) continue
    const text = normaliseAliasText(l.name)
    if (!text || text === normaliseAliasText(l.link.name)) continue
    out.set(text, { text, kind: l.link.kind, id: l.link.id })
  }
  return [...out.values()]
}

const EACH_LIKE = new Set(['each', 'dozen', 'pcs'])

/** A word the page counts in (clove, bunch, can) — not a weight, volume or plain each. */
function isCountWord(word: string): boolean {
  if (!word || /\d/.test(word)) return false
  for (const c of [canonicalUom(word), canonicalUom(singular(word))]) {
    const f = UNIT_FACTORS[c]
    if (f && f.dim !== 'count') return false
    if (EACH_LIKE.has(c)) return false
  }
  return true
}

/** "3 cloves" saved as 15 g of Garlic Peeled → 1 clove = 5 g. Item links only. */
export function countMeasureLearnings(d: DraftData): { inventoryItemId: string; word: string; qty: number; unit: string }[] {
  const out = new Map<string, { inventoryItemId: string; word: string; qty: number; unit: string }>()
  for (const l of d.lines) {
    if (l.link?.kind !== 'item') continue
    if (!(typeof l.qty === 'number' && Number.isFinite(l.qty) && l.qty > 0) || !l.unit) continue
    const { qty: count, unit: word } = readQtyText((l.qtyText ?? '').trim())
    if (!(typeof count === 'number' && count > 0) || !word || !isCountWord(word)) continue
    const w = singular(word)
    out.set(`${l.link.id}:${w}`, {
      inventoryItemId: l.link.id, word: w, qty: Number((l.qty / count).toPrecision(12)), unit: l.unit,
    })
  }
  return [...out.values()]
}
