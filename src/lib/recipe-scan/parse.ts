// Recipe Scan: validate what the reader (Claude) handed back. The tool input
// is untrusted-shaped JSON, so every field is coerced rather than assumed.
import type { ExtractedIngredient, ExtractedRecipe, ExtractedStep } from './types'

export class NotARecipeError extends Error {
  constructor(message = 'No recipe found in these files') {
    super(message)
    this.name = 'NotARecipeError'
  }
}

export class ScanTooLongError extends Error {
  constructor(message = 'Too much to read in one go — try fewer pages.') {
    super(message)
    this.name = 'ScanTooLongError'
  }
}

const MAX_MINUTES = 1440

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

function strOrNull(v: unknown): string | null {
  const s = str(v)
  return s ? s : null
}

/** Finite number, accepting numeric strings ("15"); anything else is null. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function minutes(v: unknown): number | null {
  const n = num(v)
  if (n === null) return null
  return Math.min(MAX_MINUTES, Math.max(0, Math.round(n)))
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseIngredient(v: unknown): ExtractedIngredient | null {
  if (!isObj(v)) return null
  const name = str(v.name)
  const raw = str(v.raw) || name
  if (!raw && !name) return null
  let estimate: ExtractedIngredient['estimate'] = null
  if (isObj(v.estimate)) {
    const q = num(v.estimate.qty)
    const u = str(v.estimate.unit)
    if (q !== null && q > 0 && u) estimate = { qty: q, unit: u }
  }
  return { raw, qty: num(v.qty), unit: strOrNull(v.unit), name: name || raw, estimate }
}

function parseStep(v: unknown): ExtractedStep | null {
  if (!isObj(v)) return null
  const text = str(v.text)
  if (!text) return null
  return {
    text,
    phase: str(v.phase),
    minutes: minutes(v.minutes),
    minutesStated: v.minutesStated === true,
    waitMinutes: minutes(v.waitMinutes),
    waitNote: strOrNull(v.waitNote),
    waitStated: v.waitStated === true,
  }
}

/**
 * Validates the `record_recipes` tool input. Recipes with no ingredients AND no
 * steps are dropped; an empty result means "this wasn't a recipe" (the caller
 * decides whether to throw NotARecipeError).
 */
export function parseExtraction(input: unknown): ExtractedRecipe[] {
  const list = Array.isArray(input) ? input : isObj(input) && Array.isArray(input.recipes) ? input.recipes : []
  const out: ExtractedRecipe[] = []
  for (const r of list) {
    if (!isObj(r)) continue
    const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : [])
      .map(parseIngredient).filter((x): x is ExtractedIngredient => x !== null)
    const steps = (Array.isArray(r.steps) ? r.steps : [])
      .map(parseStep).filter((x): x is ExtractedStep => x !== null)
    if (ingredients.length === 0 && steps.length === 0) continue
    out.push({
      name: str(r.name) || 'Untitled recipe',
      yieldQty: num(r.yieldQty),
      yieldUnit: strOrNull(r.yieldUnit),
      categoryHint: strOrNull(r.categoryHint),
      ingredients,
      steps,
    })
  }
  return out
}

/**
 * The decision after the reader answers: a cut-off answer (max_tokens) is
 * never trusted, and an answer with no usable recipe is "not a recipe".
 */
export function requireRecipes(input: unknown, stopReason?: string | null): ExtractedRecipe[] {
  if (stopReason === 'max_tokens') throw new ScanTooLongError()
  const recipes = parseExtraction(input)
  if (recipes.length === 0) throw new NotARecipeError()
  return recipes
}
