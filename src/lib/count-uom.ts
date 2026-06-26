/**
 * UOM conversion utilities specific to the stock count system.
 *
 * Every inventory item stores stockOnHand in its baseUnit.
 * During a count, the user may enter quantities in a different UOM
 * (e.g. a chain level "case" containing 6000 g, or "kg" when baseUnit = "g").
 * These functions handle converting back to baseUnit for persistence.
 *
 * EVERYTHING here — converters AND the display helper `formatPurchaseDisplay` —
 * resolves units through the item's pack CHAIN (`packChain` + `dimension` +
 * `baseUnit`) via the item-model engine. The legacy pack columns
 * (qtyUOM/packSize/packUOM/innerQty/qtyPerPurchaseUnit/priceType/countUOM) are
 * never read.
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
 * Item facts the count converters + display helper need — all chain-derived.
 */
interface ItemDims {
  dimension: string
  baseUnit: string
  packChain: unknown
  countUnit?: string | null
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
  const stored = item.countUnit ?? ci.countUnit
  if (stored) {
    const lv = levelBaseUnits(ci.packChain)
    const inChain = Object.keys(lv).some(k => k.toLowerCase() === stored.toLowerCase())
    if (inChain || dimensionOf(stored) === ci.dimension) return stored
  }
  const leaf = ci.packChain[ci.packChain.length - 1]?.unit
  return leaf ?? ci.baseUnit
}

/** Pack-display shape — only the CHAIN fields are read. Extra keys on a full
 *  item row are tolerated. */
interface PurchaseDisplayDims {
  dimension?: string
  baseUnit?: string
  packChain?: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any
}

/**
 * Human-readable pack display derived from the pack CHAIN. DISPLAY-ONLY.
 *
 *   single link, measured leaf  →  "case (6,000 g)"
 *   single link, count leaf     →  "case (12 each)"
 *   multi link                  →  "case (12 × 1L)"      (top.per × leaf-base baseUnit)
 *   no chain / leaf-only base    →  the unit token itself ("each", "kg")
 *
 * The top container name comes from `packChain[0].unit`; the base content comes
 * from `levelBaseUnits`. Equivalent to the old legacy-column rendering because
 * the chain was backfilled base-unit-equivalent to those columns.
 */
export function formatPurchaseDisplay(item: PurchaseDisplayDims): string {
  const ci = asChainItem(item as Parameters<typeof asChainItem>[0])
  const chain = ci.packChain
  const baseUnit = ci.baseUnit || 'each'

  // No chain → just the base unit token.
  if (!chain || chain.length === 0) return purchaseUnitToken(baseUnit) || 'each'

  const levels = levelBaseUnits(chain)
  const top = chain[0]
  const topToken = purchaseUnitToken(top.unit)
  const isContainerTok = CONTAINER_UNITS.has(topToken)
  const topBase = levels[top.unit] ?? 0   // base units in one top container

  // A single-link chain whose top IS the count leaf (top.unit === baseUnit and
  // per resolves to base) is just a bare unit — no "(detail)" wrapper.
  if (chain.length === 1 && top.unit.toLowerCase() === baseUnit.toLowerCase()) {
    return topToken || 'each'
  }

  const fmtMeasured = (val: number, unit: string) => {
    const x = (unit || '').toLowerCase()
    const n = Number.isInteger(val) ? val.toString() : parseFloat(val.toFixed(2)).toString()
    return `${n}${x === 'l' || x === 'lt' ? 'L' : x}`
  }

  // Build the "what's inside one top container" detail.
  let detail: string
  if (chain.length >= 2) {
    // Show structure: top.per inner units × the inner unit's own base content.
    const inner = chain[1]
    const innerBase = levels[inner.unit] ?? 0
    if (ci.dimension !== 'COUNT' && isMeasuredUnit(baseUnit) && innerBase > 1) {
      detail = `${fmtNum(Number(top.per))} × ${fmtMeasured(innerBase, baseUnit)}`
    } else {
      // COUNT or unit inner — show total base content.
      detail = ci.dimension === 'COUNT'
        ? `${fmtNum(topBase)} ${baseUnit}`
        : fmtMeasured(topBase, baseUnit)
    }
  } else {
    // Single link with non-trivial content: total base content of the container.
    detail = ci.dimension === 'COUNT'
      ? `${fmtNum(topBase)} ${baseUnit}`
      : fmtMeasured(topBase, baseUnit)
  }

  if (isContainerTok) return `${topToken} (${detail})`
  // Non-container top (e.g. a bare measured purchase unit): show the detail.
  return detail || topToken || 'each'
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

  // Chain levels, outer → inner. Resolve each level's base-content through the
  // SAME function the converters use (resolveUnitBase) so the listed toBase /
  // display can never diverge from what counting in that unit actually stores.
  // This matters when a chain link's name collides with the base unit — e.g. a
  // COUNT item's leaf "each" (per>1, its case content) counts as 1 single base
  // unit, NOT its pack content, so it must show "each", not "each (9 each)".
  for (const link of chain) {
    const toBase = resolveUnitBase(link.unit, ci)
    if (!(toBase > 0)) continue
    const isBaseUnit = link.unit.toLowerCase() === baseUnit.toLowerCase()
    push({
      label: link.unit,
      toBase,
      display: isBaseUnit ? link.unit : `${link.unit} (${fmtBase(toBase)} ${baseUnit})`,
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
    push({ label: 'lb', toBase: 453.592, hint: '454 g', display: 'lb' })
    push({ label: 'g', toBase: 1, display: 'g' })
  } else if (ci.dimension === 'VOLUME') {
    push({ label: 'l', toBase: 1000, hint: '1,000 ml', display: 'l' })
    push({ label: 'ml', toBase: 1, display: 'ml' })
  } else if (ci.dimension === 'COUNT') {
    // No dimensional units for COUNT, but the base unit itself is always a valid
    // option (e.g. count individual "each" even when the chain's only level is a
    // multi-unit "batch"). push() dedupes when the base is already a chain level.
    push({ label: baseUnit, toBase: getUnitConv(baseUnit) || 1, display: baseUnit })
  }

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
