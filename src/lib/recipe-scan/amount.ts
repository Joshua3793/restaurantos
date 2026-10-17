// Recipe Scan: turn "3 cloves garlic" into an amount we can cost.
//
// Rule (Joshua's decision): conversion happens ONLY for a matched item, and
// only into that item's own base unit. An unmatched line keeps its words.
// This file decides the amount/unit/status for ONE line; whether a MEDIUM
// match needs a look is decided later, not here.
import {
  UNIT_FACTORS, canonicalUom, convertQty, convertQtyBridged, dimensionallyCostable,
  type UnitDimension,
} from '@/lib/uom'
import type { DraftLine, ExtractedIngredient } from './types'

export interface AmountItem {
  dimension: 'MASS' | 'VOLUME' | 'COUNT'
  baseUnit: string
  eachMeasureQty: number | null
  eachMeasureUnit: string | null
  densityGPerMl: number | null
}

type Result = Pick<DraftLine, 'qty' | 'unit' | 'status' | 'reason'>

// ───────────────────────── parseQty ─────────────────────────

const UNICODE_FRACTIONS: Record<string, string> = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4',
  '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6',
  '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
}

function fin(n: number): number | null {
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Read ONE number off the front of `s`: "1 1/2", "1/2", "1.5", "250". */
function readOne(s: string): { value: number; rest: string } | null {
  let m = /^(\d+)\s+(\d+)\/(\d+)/.exec(s)            // mixed: 1 1/2
  if (m) {
    const d = Number(m[3])
    if (d === 0) return null
    const v = fin(Number(m[1]) + Number(m[2]) / d)
    return v === null ? null : { value: v, rest: s.slice(m[0].length) }
  }
  m = /^(\d+)\/(\d+)/.exec(s)                         // fraction: 1/2
  if (m) {
    const d = Number(m[2])
    if (d === 0) return null
    const v = fin(Number(m[1]) / d)
    return v === null ? null : { value: v, rest: s.slice(m[0].length) }
  }
  m = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?/.exec(s)         // thousands: 1,000
  if (m) {
    const v = fin(Number(m[0].replace(/,/g, '')))
    return v === null ? null : { value: v, rest: s.slice(m[0].length) }
  }
  m = /^(\d+)[.,](\d+)|^\d+|^\.\d+/.exec(s)           // decimal / integer (1,5 = 1.5)
  if (m) {
    const v = fin(Number(m[0].replace(',', '.')))
    return v === null ? null : { value: v, rest: s.slice(m[0].length) }
  }
  return null
}

/**
 * Read a quantity from the front of text: "1/2", "1½", "2-3" (a range gives its
 * middle), "250g". Returns null when there is no number ("a pinch"). Never NaN.
 */
export function parseQty(text: string): number | null {
  if (typeof text !== 'string') return null
  let s = text.trim().toLowerCase()
  // "1½" -> "1 1/2", "½" -> "1/2"
  s = s.replace(/(\d)?([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (_m, d: string | undefined, f: string) =>
    (d ? `${d} ` : '') + UNICODE_FRACTIONS[f])
  const first = readOne(s)
  if (!first) return null
  // "1-1/2" is one and a half, not a range from 1 to 1/2.
  const consumed = s.slice(0, s.length - first.rest.length)
  const hy = /^-(\d+)\/(\d+)(?!\d)/.exec(first.rest)
  if (hy && /^\d+$/.test(consumed) && Number(hy[2]) > 0) {
    return fin(first.value + Number(hy[1]) / Number(hy[2]))
  }
  const m = /^\s*(?:-|–|—|to)\s*(.*)$/.exec(first.rest)
  if (m) {
    const second = readOne(m[1])
    if (second) return fin((first.value + second.value) / 2)
  }
  return first.value
}

// ───────────────────────── resolveAmount ─────────────────────────

const ITEM_DIM: Record<AmountItem['dimension'], UnitDimension> = {
  MASS: 'weight', VOLUME: 'volume', COUNT: 'count',
}

/** "cloves" -> "clove", "bunches" -> "bunch". */
export function singular(word: string): string {
  const w = word.trim().toLowerCase()
  if (/(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 1) return w.slice(0, -1)
  return w
}

function plural(word: string, qty: number): string {
  if (qty === 1) return word
  if (/(ch|sh|x|s)$/.test(word)) return `${word}es`
  return `${word}s`
}

function num(n: number): string {
  return String(Number(n.toFixed(2)))
}

function tidy(n: number): number {
  return Number(n.toPrecision(12))
}

function validQty(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

/** Look a unit up in the unit table, tolerating a plural ("teaspoons"). */
function unitDef(unit: string): { canon: string; dim: UnitDimension } | null {
  const c = canonicalUom(unit)
  if (UNIT_FACTORS[c]) return { canon: c, dim: UNIT_FACTORS[c].dim }
  const s = canonicalUom(singular(unit))
  if (UNIT_FACTORS[s]) return { canon: s, dim: UNIT_FACTORS[s].dim }
  return null
}

function bridgeOf(item: AmountItem): { qty: number; unit: string } | null {
  const u = item.eachMeasureUnit ? unitDef(item.eachMeasureUnit) : null
  return validQty(item.eachMeasureQty) && u
    ? { qty: item.eachMeasureQty, unit: u.canon }
    : null
}

const EACH_LIKE = new Set(['each', 'dozen'])

/**
 * Express `qty unit` in the item's own base unit. `crossed` = weight<->volume
 * with no density to go on (so the 1:1 passthrough is a guess). `ok` = false
 * when the unit cannot be costed against this item at all.
 */
function intoItem(
  qty: number, unit: string, item: AmountItem,
): { ok: boolean; qty: number; crossed: boolean } {
  const bridge = bridgeOf(item)
  const from = unitDef(unit)
  const to = unitDef(item.baseUnit)
  if (!from || !to) return { ok: false, qty: 0, crossed: false }
  if (!dimensionallyCostable(from.canon, to.canon, bridge)) return { ok: false, qty: 0, crossed: false }
  const density = item.densityGPerMl && item.densityGPerMl > 0 ? item.densityGPerMl : null
  const measured = (d: UnitDimension) => d === 'weight' || d === 'volume'
  const crossed = measured(from.dim) && measured(to.dim) && from.dim !== to.dim && !density
  const out = convertQtyBridged(qty, from.canon, to.canon, bridge, density)
  if (!Number.isFinite(out)) return { ok: false, qty: 0, crossed: false }
  return { ok: true, qty: tidy(out), crossed }
}

function crossReason(unit: string, item: AmountItem): string {
  const u = unitDef(unit)?.canon ?? (canonicalUom(unit) || unit)
  return item.dimension === 'MASS'
    ? `${u} for a weighed item — check`
    : `${u} for a measured-volume item — check`
}

export function resolveAmount(
  ing: ExtractedIngredient,
  item: AmountItem | null,
  learned: { word: string; qty: number; unit: string } | null,
): Result {
  // Not matched: leave the words alone, convert nothing.
  if (!item) return { qty: null, unit: null, status: 'NO_MATCH', reason: null }

  // "salt to taste", or a quantity we cannot trust.
  if (!validQty(ing.qty)) {
    return { qty: 0, unit: item.baseUnit, status: 'NO_AMOUNT', reason: null }
  }
  const qty = ing.qty
  const rawUnit = (ing.unit ?? '').trim()
  const itemDim = ITEM_DIM[item.dimension]
  const baseDef = unitDef(item.baseUnit)
  const def = rawUnit ? unitDef(rawUnit) : null

  // A real measure (g, ml, cup, tsp...) -> the item's own base unit.
  if (def && def.dim !== 'count') {
    const r = intoItem(qty, rawUnit, item)
    if (r.ok) {
      return r.crossed
        ? { qty: r.qty, unit: item.baseUnit, status: 'CHECK', reason: crossReason(rawUnit, item) }
        : { qty: r.qty, unit: item.baseUnit, status: 'MATCHED', reason: null }
    }
    // Measured amount for a counted item with no each-measure to go through.
    return {
      qty: null, unit: null, status: 'CHECK',
      reason: `${num(qty)} ${def.canon} — this item is counted, how many?`,
    }
  }

  // Bare number, or each/dozen, on a counted item.
  if (itemDim === 'count' && baseDef) {
    if (!rawUnit) return { qty: tidy(qty), unit: item.baseUnit, status: 'MATCHED', reason: null }
    if (def && (def.canon === baseDef.canon || (EACH_LIKE.has(def.canon) && EACH_LIKE.has(baseDef.canon)))) {
      return { qty: tidy(convertQty(qty, rawUnit, item.baseUnit)), unit: item.baseUnit, status: 'MATCHED', reason: null }
    }
  }

  // "each" on a measured item: that is what the item's each-measure is for.
  if (def && EACH_LIKE.has(def.canon) && itemDim !== 'count' && bridgeOf(item)) {
    const r = intoItem(qty, rawUnit, item)
    if (r.ok) return { qty: r.qty, unit: item.baseUnit, status: 'MATCHED', reason: null }
  }

  // Everything else is a count word (clove, bunch, can, bag...), or a bare
  // number on a measured item. Needs a learned measure, an estimate, or a question.
  const word = rawUnit ? singular(rawUnit) : ''
  const label = word ? `${num(qty)} ${plural(word, qty)}` : num(qty)

  if (learned && word && singular(learned.word) === word && validQty(learned.qty)) {
    const r = intoItem(qty * learned.qty, learned.unit, item)
    if (r.ok) {
      return r.crossed
        ? { qty: r.qty, unit: item.baseUnit, status: 'CHECK', reason: crossReason(learned.unit, item) }
        : { qty: r.qty, unit: item.baseUnit, status: 'MATCHED', reason: null }
    }
  }

  const est = ing.estimate
  if (est && validQty(est.qty) && est.unit) {
    const r = intoItem(est.qty, est.unit, item)
    if (r.ok) {
      return {
        qty: r.qty, unit: item.baseUnit, status: 'CHECK',
        reason: `${label} — about ${num(est.qty)} ${unitDef(est.unit)?.canon ?? est.unit}, check`,
      }
    }
  }

  return {
    qty: null, unit: null, status: 'CHECK',
    reason: word ? `${label} — how much is a ${word}?` : `${label} — how much is that?`,
  }
}
