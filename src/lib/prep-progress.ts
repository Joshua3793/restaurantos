// Cook-along progress — what a cook has done in the item drawer (the scale, the
// ingredients ticked off, the method steps ticked) while the item sits on the
// To Do. It rides the item's ONE live log (`PrepLog.progress`) so it survives
// closing the drawer, a reload, and a second device, and it is cleared only
// when the job completes / is skipped / leaves the list — never on Stop.
//
// Keys are STABLE ids, not positions: ingredients by RecipeIngredient id, method
// steps by MethodStep.key (legacy text steps by `s<idx>`), so a recipe edit
// does not shift a cook's ticks onto the wrong row.
import type { MethodStep } from './recipe-method'

export interface PrepProgress {
  /** The upscale slider's yield in the item's unit; null = use the suggestion. */
  makeQty: number | null
  /** RecipeIngredient ids ticked off. */
  ingredients: string[]
  /** Method step keys ticked (see stepKeyAt). */
  steps: string[]
}

export const EMPTY_PROGRESS: PrepProgress = { makeQty: null, ingredients: [], steps: [] }

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))] : []

/** Sanitise what the API stores / the client reads. Null for anything that is not an object. */
export function parseProgress(v: unknown): PrepProgress | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const makeQty = typeof o.makeQty === 'number' && Number.isFinite(o.makeQty) && o.makeQty > 0 ? o.makeQty : null
  return { makeQty, ingredients: strList(o.ingredients), steps: strList(o.steps) }
}

export const isEmptyProgress = (p: PrepProgress): boolean =>
  p.makeQty == null && p.ingredients.length === 0 && p.steps.length === 0

/** The key a method step is ticked under: its own key, else a stable index key for legacy text steps. */
export const stepKeyAt = (method: ReadonlyArray<MethodStep> | null | undefined, idx: number): string =>
  method?.[idx]?.key ?? `s${idx}`

export const toggleKey = (list: string[], key: string): string[] =>
  list.includes(key) ? list.filter(k => k !== key) : [...list, key]
