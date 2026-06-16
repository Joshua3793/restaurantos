/**
 * UOM conversion utilities specific to the stock count system.
 *
 * Every inventory item stores stockOnHand in its baseUnit.
 * During a count, the user may enter quantities in a different UOM
 * (e.g. a chain level "case" containing 6000 g, or "kg" when baseUnit = "g").
 * These functions handle converting back to baseUnit for persistence.
 *
 * The COUNT CONVERTERS resolve every unit through the item's pack CHAIN
 * (`packChain` + `dimension` + `baseUnit`) via the item-model engine — they
 * never read the legacy pack columns (qtyUOM/packSize/packUOM/innerQty/
 * qtyPerPurchaseUnit). Only the display-only helpers (`formatPurchaseDisplay`,
 * `buildCaseHint`) remain legacy-driven for now; Phase B converts the forms.
 */

import { CONTAINER_UNITS, purchaseUnitToken } from './uom'
import { getUnitConv, isMeasuredUnit } from './utils'
import { asChainItem, levelBaseUnits, dimensionOf } from './item-model'

export interface CountableUom {
  label: string
  /** How many baseUnits make up 1 of this UOM. */
  toBase: number
  /** Human-readable description of what 1 of this unit contains, e.g. "20 kg" or "12 each". */
  hint?: string
  /** Chip/option text shown in the UI — e.g. "case (25kg)", "pkg (9 × 85g)". Falls back to label. */
  display?: string
}

/**
 * Item facts the count converters need. The CONVERTERS read only the chain
 * fields (`dimension`/`baseUnit`/`packChain`/`countUnit`). The legacy pack
 * columns remain on the interface as OPTIONAL purely so the display-only
 * helpers (`formatPurchaseDisplay`/`buildCaseHint`) can keep their legacy
 * behaviour until Phase B — the converters never touch them.
 */
interface ItemDims {
  dimension: string
  baseUnit: string
  packChain: unknown
  countUnit?: string | null
  // legacy, display-only (formatPurchaseDisplay / buildCaseHint)
  purchaseUnit?: string
  qtyPerPurchaseUnit?: number | { toString(): string }
  qtyUOM?: string | null
  innerQty?: { toString(): string } | number | null
  packSize?: number | { toString(): string }
  packUOM?: string
  countUOM?: string
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toString()
  if (n >= 10) return Math.round(n).toString()
  return n.toFixed(1)
}

/**
 * BACKWARD-COMPAT shim: resolve a (possibly generic) selectedUom to base units
 * per 1 of that unit, via the item's pack chain.
 *
 * Stored selectedUom values from existing count sessions use generic labels
 * (case/pack/each/kg/g/baseUnit) as well as real chain-level names — both must
 * resolve identically to the legacy formula.
 */
function resolveUnitBase(selectedUom: string, item: ItemDims): number {
  const ci = asChainItem(item as Parameters<typeof asChainItem>[0])
  const sel = (selectedUom || '').toLowerCase()
  const levels = levelBaseUnits(ci.packChain)          // keys are the chain unit names

  // 0. The item's own baseUnit always converts 1:1 (g→g, ml→ml, each→each). This
  //    MUST win over a chain level that happens to share the base unit's name —
  //    a COUNT item's leaf is named "each" with per>1 (its case content), but
  //    counting in base "each" means single base units (1), not a leaf-pack.
  if (sel === ci.baseUnit.toLowerCase()) return getUnitConv(ci.baseUnit)
  // 1. exact chain-level name (case/head/bottle/can/sleeve…)
  for (const k of Object.keys(levels)) if (k.toLowerCase() === sel) return levels[k]
  // 2. same-dimension MEASURED unit (kg/g/ml/l/lb). Restricted to weight/volume
  //    so COUNT container/purchase names (case/pack/batch) don't collapse to 1 —
  //    they resolve through the chain in step 3.
  if (isMeasuredUnit(selectedUom) && dimensionOf(selectedUom) === ci.dimension) return getUnitConv(selectedUom)
  // 3. legacy generic labels → map onto chain levels
  const top = ci.packChain[0]?.unit
  const leaf = ci.packChain[ci.packChain.length - 1]?.unit
  if (sel === 'case' && top) return levels[top]
  if (sel === 'each' && leaf) return levels[leaf]
  if (sel === 'pack') { const mid = ci.packChain[1]?.unit ?? leaf; return mid ? levels[mid] : 1 }
  // 4. cross-dimension or unknown unit the chain can't resolve: 1:1 passthrough,
  //    matching the legacy convertQty no-op (e.g. a 'kg' label on a COUNT item).
  if (dimensionOf(selectedUom) !== ci.dimension) return 1
  // 5. fallback: leaf level (smallest), else 1
  return leaf ? levels[leaf] : 1
}

/**
 * Returns the stored countUnit if it resolves (is a chain level or same-dim
 * unit), else the leaf level name, else baseUnit.
 */
export function resolveCountUom(item: ItemDims): string {
  const ci = asChainItem(item as Parameters<typeof asChainItem>[0])
  const stored = item.countUnit ?? item.countUOM ?? ci.countUnit
  if (stored) {
    const lv = levelBaseUnits(ci.packChain)
    const inChain = Object.keys(lv).some(k => k.toLowerCase() === stored.toLowerCase())
    if (inChain || dimensionOf(stored) === ci.dimension) return stored
  }
  const leaf = ci.packChain[ci.packChain.length - 1]?.unit
  return leaf ?? ci.baseUnit
}

/** Legacy display-only shape — only the pack columns are read. Extra keys (e.g.
 *  baseUnit/countUOM on a full item row) are tolerated. */
interface PurchaseDisplayDims {
  purchaseUnit?: string
  qtyPerPurchaseUnit?: number | { toString(): string }
  qtyUOM?: string | null
  innerQty?: { toString(): string } | number | null
  packSize?: number | { toString(): string }
  packUOM?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any
}

/**
 * Human-readable pack display derived ONLY from the legacy structured columns
 * (never a stored string). DISPLAY-ONLY — not used by the count converters.
 * Phase B converts this to the chain.
 */
export function formatPurchaseDisplay(item: PurchaseDisplayDims): string {
  const token = purchaseUnitToken(item.purchaseUnit ?? 'each')
  const isContainerTok = CONTAINER_UNITS.has(token)
  const qtyUOM = item.qtyUOM ?? 'each'
  const qty = Number(item.qtyPerPurchaseUnit ?? 1)
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null
  const fmtWV = (val: number, unit: string) => {
    const x = (unit || '').toLowerCase()
    const n = Number.isInteger(val) ? val.toString() : parseFloat(val.toFixed(2)).toString()
    return `${n}${x === 'l' || x === 'lt' ? 'L' : x}`
  }
  let detail = ''
  if (qtyUOM === 'pack' && innerQty && innerQty > 0) detail = `${fmtNum(qty)} pkg`
  else if (isMeasuredUnit(qtyUOM) && qty > 1) detail = fmtWV(qty, qtyUOM)
  else if (isMeasuredUnit(pu) && ps > 0) detail = qty > 1 ? `${fmtNum(qty)} × ${fmtWV(ps, pu)}` : fmtWV(ps, pu)
  else if ((pu ?? 'each').toLowerCase() === 'each' && ps > 1) detail = `${fmtNum(qty > 1 ? qty * ps : ps)} each`

  if (isContainerTok) return detail ? `${token} (${detail})` : token
  if (detail) return detail
  return token || 'each'
}

/**
 * Returns the UOM options a user can choose from when counting an item.
 * Sourced from the pack CHAIN — every chain level (outer→inner) plus the
 * dimensional count units for the item's dimension that aren't already a level.
 */
export function getCountableUoms(item: ItemDims): CountableUom[] {
  const ci = asChainItem(item as Parameters<typeof asChainItem>[0])
  const chain = ci.packChain
  const levels = levelBaseUnits(chain)
  const baseUnit = ci.baseUnit

  const uoms: CountableUom[] = []
  const seen = new Set<string>()
  const push = (u: CountableUom) => {
    const key = u.label.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    uoms.push(u)
  }

  const fmtBase = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })

  // Chain levels, outer → inner.
  for (const link of chain) {
    const toBase = levels[link.unit] ?? 0
    if (!(toBase > 0)) continue
    push({
      label: link.unit,
      toBase,
      display: `${link.unit} (${fmtBase(toBase)} ${baseUnit})`,
    })
  }

  // Whether the chain has a "measured leaf" — a real per-each weight/volume,
  // i.e. the leaf carries a non-1 base content for a MASS/VOLUME item.
  const leaf = chain[chain.length - 1]
  const leafBase = leaf ? (levels[leaf.unit] ?? 0) : 0
  const hasMeasuredLeaf = ci.dimension !== 'COUNT' && leafBase > 0

  // Dimensional count units for the item's dimension not already a level.
  if (ci.dimension === 'MASS' && hasMeasuredLeaf) {
    push({ label: 'kg', toBase: 1000, hint: '1,000 g', display: 'kg' })
    push({ label: 'g', toBase: 1, display: 'g' })
    push({ label: 'lb', toBase: 453.592, hint: '454 g', display: 'lb' })
  } else if (ci.dimension === 'VOLUME') {
    push({ label: 'l', toBase: 1000, hint: '1,000 ml', display: 'l' })
    push({ label: 'ml', toBase: 1, display: 'ml' })
  }
  // COUNT: no extra dimensional units.

  return uoms
}

/**
 * Convert a quantity entered by the user (in selectedUom) to the item's baseUnit.
 * This is what gets written to stockOnHand. Resolved entirely via the chain.
 */
export function convertCountQtyToBase(
  qty: number,
  selectedUom: string,
  item: ItemDims,
): number {
  return qty * resolveUnitBase(selectedUom, item)
}

export type CountEntry = { unit: string; qty: number }

/** Sum a mixed-unit count to base units. Each entry converts independently. */
export function countEntriesToBase(entries: CountEntry[] | null | undefined, item: ItemDims): number {
  if (!entries || entries.length === 0) return 0
  return entries.reduce((sum, e) => sum + convertCountQtyToBase(Number(e.qty) || 0, e.unit, item), 0)
}

/** Resolve a line's counted base: entries if present, else the single qty/uom. */
export function lineCountedBase(
  line: { entries?: unknown; countedQty: number | { toString(): string } | null; selectedUom: string },
  item: ItemDims,
): number {
  const entries = Array.isArray(line.entries) ? (line.entries as CountEntry[]) : null
  if (entries && entries.length) return countEntriesToBase(entries, item)
  return line.countedQty != null ? convertCountQtyToBase(Number(line.countedQty), line.selectedUom, item) : 0
}

/**
 * Convert a baseUnit quantity to the selectedUom — for displaying expected quantities.
 */
export function convertBaseToCountUom(
  baseQty: number,
  selectedUom: string,
  item: ItemDims,
): number {
  const per = resolveUnitBase(selectedUom, item)
  return per > 0 ? baseQty / per : baseQty
}
