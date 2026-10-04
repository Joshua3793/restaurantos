/**
 * The pure planner behind "Change how it's measured" (item backbone Stage 2c).
 *
 * A measure change is ONE number: `k` = new base units per 1 old base unit
 * (150 when "1 each = 150 g" turns a pieces item into a weight item). Everything
 * else follows from it:
 *   • chains keep their containers (case, bag, each…) and collapse their measure
 *     links into them, so a case still holds what it held;
 *   • prices keep their $/base — `pricePerBaseUnit(after) × k = pricePerBaseUnit(before)`;
 *   • frozen rows (receipts, counts, snapshots, stock baselines) are RE-DERIVED
 *     through the receiving / count rules against the corrected item — the same
 *     planners the create-new repair uses — and only a row those rules cannot
 *     read is scaled `old × k`, and counted as such in the summary.
 *
 * Nothing invented. Pure + client-safe — no Prisma, no I/O.
 */

import { canonicalUom, convertQty, unitKind, UNIT_FACTORS } from '@/lib/uom'
import {
  asChainItem, dimensionOf, pricePerBaseUnit, validateChainItem, DIMENSION_BASE,
  type ChainItem, type Dimension, type EachMeasure, type PackLink, type Pricing,
} from '@/lib/item-model'
import {
  planReceiptRefreeze, planCountRefreeze, planStockRewrite, planSessionTotals, isMaterial,
  type ReceiptLine, type CountLineRow, type ReceiptRefreezeRow, type CountRefreezeRow,
  type StockRewrite, type StockCountRow, type SessionSnapshotRow, type SessionTotalRow,
} from '@/lib/invoice/create-new-repair'
import { formatPurchaseDisplay } from '@/lib/count-uom'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** The target measure: a dimension, and the unit of that dimension a human
 *  thinks in ('each' for COUNT). The unit is a display choice — the base is
 *  always `DIMENSION_BASE[dimension]`. */
export interface Measure { dimension: Dimension; unit: string }

/** "One piece = 150 g" (`eachQty` + `eachUnit`) or a density in g/ml. */
export interface Bridge { eachQty?: number | null; eachUnit?: string | null; densityGPerMl?: number | null }

export type RemeasureErrorCode = 'SAME_MEASURE' | 'NEEDS_BRIDGE'
export interface RemeasureError { error: string; code: RemeasureErrorCode }

export interface RemeasureBoxInput {
  id: string
  supplierName: string | null
  isPrimary: boolean
  packChain: unknown
  pricing: unknown
  packQty?: unknown
  packSize?: unknown
  packUOM?: string | null
}

export interface RemeasureInput {
  item: Parameters<typeof asChainItem>[0] & {
    id: string
    itemName: string
    stockOnHand?: unknown
    lastCountQty?: unknown
    isStocked: boolean
  }
  to: Measure
  bridge: Bridge
  boxes: RemeasureBoxInput[]
  /** Approved lines, with `parentLineId` resolved for RC clones. */
  receipts: ReceiptLine[]
  /** Count lines, with the finalize snapshot attached. */
  counts: CountLineRow[]
  countSessions: {
    lineId: string
    sessionDate: Date | string
    revenueCenterId: string | null
    rcIsDefault: boolean
    skipped: boolean
    countedQty: number | null
  }[]
  allocations: { revenueCenterId: string; quantity: unknown }[]
  sessions: { id: string; snapshots: SessionSnapshotRow[]; totalCountedValue: unknown }[]
  transfers: { id: string; quantity: unknown }[]
  recipeLines: number
  wastageRows: number
}

export interface RemeasureSummary {
  from: { dimension: Dimension; unit: string; packLabel: string; priceLabel: string; countUnit: string }
  to: { dimension: Dimension; unit: string; packLabel: string; priceLabel: string; countUnit: string }
  boxes: { supplierName: string; isPrimary: boolean; before: string; after: string }[]
  counts: { n: number; scaled: number }
  receipts: { n: number; scaled: number }
  transfers: number
  recipes: number
  wastage: number
  warnings: string[]
}

export interface RemeasurePlan {
  k: number
  item: {
    before: ChainItem
    after: ChainItem & { countUnit: string }
    /** The bridges to WRITE onto the item. */
    eachMeasure?: EachMeasure | null
    densityGPerMl?: number | null
  }
  boxes: {
    id: string
    supplierName: string | null
    isPrimary: boolean
    before: { packChain: unknown; pricing: unknown; packQty: unknown; packSize: unknown; packUOM: string | null }
    packChain: PackLink[]
    pricing: Pricing
  }[]
  receipts: (ReceiptRefreezeRow & { scaled: boolean })[]
  counts: (CountRefreezeRow & { scaled: boolean })[]
  stock: StockRewrite
  sessions: SessionTotalRow[]
  transfers: { id: string; old: number; next: number }[]
  summary: RemeasureSummary
  /** `validateChainItem` on the corrected item + every box. Non-empty ⇒ refuse. */
  errors: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const round6 = (x: number) => Math.round(x * 1e6) / 1e6

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

/** A link the change keeps: a container (case, bag…) or a piece (`each`). */
const isContainer = (unit: string) => unitKind(unit) === 'container' || canonicalUom(unit) === 'each'

/** Base units in one `unit` of its own dimension; 1 for each and for anything
 *  the table does not know. */
const toBase = (unit: string): number => UNIT_FACTORS[canonicalUom(unit)]?.toBase ?? 1

const MEASURE_WORD: Record<Dimension, string> = { MASS: 'weight', VOLUME: 'volume', COUNT: 'pieces' }

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

// ─────────────────────────────────────────────────────────────────────────────
// The factor
// ─────────────────────────────────────────────────────────────────────────────

/** k = new base units per 1 old base unit, or the plain sentence saying what is
 *  missing. The bridge in the REQUEST is the only one read — the item's stored
 *  bridge is a prefill for the form, never a silent fallback. */
export function remeasureFactor(from: ChainItem, to: Measure, bridge: Bridge): { k: number } | RemeasureError {
  if (to.dimension === from.dimension) {
    return { error: `It is already measured by ${MEASURE_WORD[from.dimension]}.`, code: 'SAME_MEASURE' }
  }

  if (from.dimension === 'COUNT' || to.dimension === 'COUNT') {
    const measured = from.dimension === 'COUNT' ? to.dimension : from.dimension
    const qty = Number(bridge.eachQty)
    const unit = (bridge.eachUnit ?? '').trim()
    if (!(qty > 0) || !unit || dimensionOf(unit) !== measured) {
      const verb = measured === 'VOLUME' ? 'holds' : 'weighs'
      return { error: `Tell the app how much one piece ${verb} first — for example 1 each = 150 g.`, code: 'NEEDS_BRIDGE' }
    }
    const perEach = convertQty(qty, unit, DIMENSION_BASE[measured])
    return { k: from.dimension === 'COUNT' ? perEach : 1 / perEach }
  }

  // MASS ↔ VOLUME
  const d = Number(bridge.densityGPerMl)
  if (!(d > 0)) return { error: 'Tell the app the density first — how many grams 1 ml weighs.', code: 'NEEDS_BRIDGE' }
  return { k: from.dimension === 'MASS' ? 1 / d : d }
}

// ─────────────────────────────────────────────────────────────────────────────
// The chain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Container links kept, measure links collapsed through k.
 *
 * Each kept container's `per` is the product of the links from it down to the
 * next kept container — exactly its own `per` when the two are adjacent (every
 * example in the plan), and the folded-in content when a measure link sat
 * between them, so a container always holds what it held: a COUNT "case of 15
 * dozen" stays 180 pieces instead of becoming 15.
 */
export function rewriteChain(chain: PackLink[], fromDim: Dimension, to: Measure, k: number): PackLink[] {
  const links = Array.isArray(chain) ? chain : []
  const kept = links.map((l, i) => ({ l, i })).filter(({ l }) => isContainer(l.unit))

  // Base units contained in one of link i (old base).
  const contentFrom = (i: number, end: number) => {
    let p = 1
    for (let j = i; j < end; j++) p *= Number(links[j].per)
    return p
  }

  if (kept.length === 0) {
    if (fromDim === 'COUNT') return [{ unit: 'each', per: round6(k) }]
    // The pack no longer exists — a bare measure of the new dimension.
    return [{ unit: to.unit, per: toBase(to.unit) }]
  }

  const out: PackLink[] = kept.map(({ l, i }, n) => {
    const nextIdx = n + 1 < kept.length ? kept[n + 1].i : links.length
    return { unit: l.unit, per: contentFrom(i, nextIdx) }
  })
  const inner = out[out.length - 1]

  if (fromDim === 'COUNT') {
    // Old base = each. An innermost each becomes "1 each = k"; otherwise a piece
    // link is appended under the innermost container.
    if (canonicalUom(inner.unit) === 'each') inner.per = round6(inner.per * k)
    else out.push({ unit: 'each', per: round6(k) })
    return out
  }

  // Measured → anything: the innermost container held old base; express it in new base.
  inner.per = round6(inner.per * k)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// The price
// ─────────────────────────────────────────────────────────────────────────────

/** Same $/base after conversion. PACK stays PACK unless the chain collapsed to a
 *  bare measure (then the pack no longer exists and the price becomes a RATE). */
export function rewritePricing(before: ChainItem, afterChain: PackLink[], to: Measure, k: number): Pricing {
  const collapsed = before.dimension !== 'COUNT' && !(before.packChain ?? []).some((l) => isContainer(l.unit))
  if (before.pricing?.mode === 'PACK' && !collapsed) return before.pricing
  const ppbNew = pricePerBaseUnit(before) / k
  // Deliberately NOT rounded: the Global Constraints hold $/base × k to a 1e-9
  // relative tolerance, which a 4-dp rate cannot meet. Labels round for people.
  return { mode: 'RATE', rate: ppbNew * toBase(to.unit), rateUnit: to.unit }
}

// ─────────────────────────────────────────────────────────────────────────────
// The count unit
// ─────────────────────────────────────────────────────────────────────────────

/** The old count unit if it still names a link of the new chain (returned in the
 *  link's own spelling, so `validateChainItem` finds it) or a unit of the new
 *  dimension; else the target unit. */
export function rewriteCountUnit(countUnit: string | null | undefined, afterChain: PackLink[], to: Measure): string {
  if (!countUnit || !countUnit.trim()) return to.unit
  const u = canonicalUom(countUnit)
  const link = afterChain.find((l) => canonicalUom(l.unit) === u)
  if (link) return link.unit
  if (dimensionOf(u) === to.dimension) return countUnit
  return to.unit
}

// ─────────────────────────────────────────────────────────────────────────────
// Labels
// ─────────────────────────────────────────────────────────────────────────────

/** "case (12 × 150g)" — the count/drawer display, unchanged. */
export function packLabel(ci: ChainItem): string {
  return formatPurchaseDisplay(ci)
}

/** "$40.00 per case" (PACK) · "$6.05 per lb" (RATE). */
export function priceLabel(ci: ChainItem): string {
  const p = ci.pricing
  if (p?.mode === 'RATE') return `$${num(p.rate).toFixed(2)} per ${p.rateUnit}`
  const top = ci.packChain?.[0]?.unit ?? ci.baseUnit
  return `$${num((p as { purchasePrice?: unknown } | undefined)?.purchasePrice).toFixed(2)} per ${top}`
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

/** $/base × k must equal the old $/base. A chain whose purchase unit was itself
 *  a measure link above a container would break that silently — refuse it. The
 *  tolerance is looser than the constraint's 1e-9 only to absorb `round6` on a
 *  small `per`; a real mistake is off by a whole factor. */
function priceMoved(before: ChainItem, after: ChainItem, k: number): boolean {
  const a = pricePerBaseUnit(before)
  const b = pricePerBaseUnit(after) * k
  return Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b)) * 1e-6
}

export function planRemeasure(input: RemeasureInput): RemeasurePlan | RemeasureError {
  const before = asChainItem(input.item)
  const to: Measure = {
    dimension: input.to.dimension,
    unit: dimensionOf(input.to.unit) === input.to.dimension && UNIT_FACTORS[canonicalUom(input.to.unit)]
      ? input.to.unit
      : DIMENSION_BASE[input.to.dimension],
  }

  const f = remeasureFactor(before, to, input.bridge)
  if ('error' in f) return f
  const { k } = f

  // ── The item ───────────────────────────────────────────────────────────────
  const countRewrite = before.dimension === 'COUNT' || to.dimension === 'COUNT'
  const eachMeasure: EachMeasure | null = countRewrite
    ? { qty: Number(input.bridge.eachQty), unit: String(input.bridge.eachUnit).trim() }
    : before.eachMeasure ?? null
  const densityGPerMl: number | null = countRewrite
    ? before.densityGPerMl ?? null
    : Number(input.bridge.densityGPerMl)

  let afterChain = rewriteChain(before.packChain, before.dimension, to, k)
  let afterPricing = rewritePricing(before, afterChain, to, k)

  // ── Boxes ──────────────────────────────────────────────────────────────────
  const errors: string[] = []
  const boxBase = { dimension: to.dimension, baseUnit: DIMENSION_BASE[to.dimension], eachMeasure, densityGPerMl }
  const boxes = input.boxes.map((box) => {
    const boxCi: ChainItem = {
      ...before,
      packChain: Array.isArray(box.packChain) ? (box.packChain as PackLink[]) : [],
      pricing: (box.pricing as Pricing) ?? { mode: 'PACK', purchasePrice: 0 },
    }
    const packChain = rewriteChain(boxCi.packChain, before.dimension, to, k)
    const pricing = rewritePricing(boxCi, packChain, to, k)
    return { box, boxCi, packChain, pricing }
  })
  // The item equals its main box (src/lib/primary-offer.ts): identical maths
  // anyway — this guarantees byte-equality.
  const primary = boxes.find((b) => b.box.isPrimary)
  if (primary) {
    afterChain = primary.packChain
    afterPricing = primary.pricing
  }

  const countUnit = rewriteCountUnit(input.item.countUnit, afterChain, to)
  const after: ChainItem & { countUnit: string } = {
    ...boxBase,
    packChain: afterChain,
    pricing: afterPricing,
    countUnit,
  }

  const opts = { requirePositivePrice: input.item.isStocked }
  errors.push(...validateChainItem(after, opts))
  if (priceMoved(before, after, k)) errors.push('the price per unit would change — this pack cannot be converted as it is')
  for (const b of boxes) {
    const name = b.box.supplierName ?? 'A supplier'
    const boxAfter: ChainItem = { ...after, packChain: b.packChain, pricing: b.pricing }
    for (const e of validateChainItem(boxAfter, opts)) errors.push(`${name}: ${e}`)
    if (priceMoved(b.boxCi, boxAfter, k)) errors.push(`${name}: the price per unit would change — this pack cannot be converted as it is`)
  }

  const ppb = pricePerBaseUnit(after)

  // ── Receipts ───────────────────────────────────────────────────────────────
  const receipts = planReceiptRefreeze(input.receipts, after).map((r) => {
    const unread = r.via === 'none' || (r.next === 0 && (r.old ?? 0) !== 0)
    return unread
      ? { ...r, next: (r.old ?? 0) * k, via: 'scaled', scaled: true }
      : { ...r, scaled: false }
  })

  // ── Counts ─────────────────────────────────────────────────────────────────
  const counts = planCountRefreeze(input.counts, after, ppb).map((c) => {
    if (!c.needsDecision) return { ...c, scaled: false }
    const next = (c.old ?? 0) * k
    const row: CountRefreezeRow & { scaled: boolean } = { ...c, next, via: 'scaled', needsDecision: false, scaled: true }
    if (c.snapshot) row.snapshot = { ...c.snapshot, qtyOnHand: next, totalValue: next * ppb }
    return row
  })

  // ── Stock baselines ────────────────────────────────────────────────────────
  const sessionOf = new Map(input.countSessions.map((s) => [s.lineId, s]))
  const countLines: StockCountRow[] = []
  for (const c of counts) {
    const s = sessionOf.get(c.id)
    if (!s) continue
    countLines.push({
      id: c.id,
      next: c.next,
      skipped: s.skipped,
      countedQty: s.countedQty,
      sessionDate: s.sessionDate,
      revenueCenterId: s.revenueCenterId,
      rcIsDefault: s.rcIsDefault,
    })
  }
  const stock = planStockRewrite({
    item: input.item,
    allocations: input.allocations,
    countLines,
    rewrite: { dimension: to.dimension },
  })

  // ── Sessions + transfers ───────────────────────────────────────────────────
  const sessions = planSessionTotals(
    input.sessions.map((s) => ({ ...s, totalCountedValue: s.totalCountedValue as number | string | null })),
    new Map(counts.filter((c) => c.snapshot).map((c) => [c.snapshot!.id, c.snapshot!.totalValue])),
  )
  const transfers = input.transfers.map((t) => {
    const old = num(t.quantity)
    return { id: t.id, old, next: round6(old * k) }
  })

  // ── Summary ────────────────────────────────────────────────────────────────
  const countsScaled = counts.filter((c) => c.scaled).length
  const receiptsScaled = receipts.filter((r) => r.scaled).length
  const mismatched = counts.filter((c) => c.snapshotMismatch).length
  const warnings: string[] = []
  if (countsScaled > 0) {
    warnings.push(`${countsScaled} ${plural(countsScaled, 'count', 'counts')} could not be re-read from what was typed and ${plural(countsScaled, 'was', 'were')} scaled instead.`)
  }
  if (receiptsScaled > 0) {
    warnings.push(`${receiptsScaled} ${plural(receiptsScaled, 'delivery', 'deliveries')} could not be re-read from the invoice and ${plural(receiptsScaled, 'was', 'were')} scaled instead.`)
  }
  if (mismatched > 0) {
    warnings.push(`${mismatched} count ${plural(mismatched, 'snapshot was', 'snapshots were')} left alone (${plural(mismatched, 'it no longer matches its', 'they no longer match their')} count line).`)
  }
  if (stock.stockOnHand.next == null && stock.stockOnHand.old !== 0) {
    warnings.push('Stock on hand was left alone — no finalized count sets it.')
  }

  const line = (c: ChainItem) => `${packLabel(c)} · ${priceLabel(c)}`
  const summary: RemeasureSummary = {
    from: {
      dimension: before.dimension, unit: before.baseUnit,
      packLabel: packLabel(before), priceLabel: priceLabel(before), countUnit: before.countUnit ?? before.baseUnit,
    },
    to: {
      dimension: to.dimension, unit: to.unit,
      packLabel: packLabel(after), priceLabel: priceLabel(after), countUnit,
    },
    boxes: boxes.map((b) => ({
      supplierName: b.box.supplierName ?? '',
      isPrimary: b.box.isPrimary,
      before: line(b.boxCi),
      after: line({ ...after, packChain: b.packChain, pricing: b.pricing }),
    })),
    counts: {
      n: counts.filter((c) => isMaterial(c.old, c.next) || c.snapshot || c.snapshotUnitOnly).length,
      scaled: countsScaled,
    },
    receipts: { n: receipts.filter((r) => isMaterial(r.old, r.next)).length, scaled: receiptsScaled },
    transfers: transfers.filter((t) => isMaterial(t.old, t.next)).length,
    recipes: input.recipeLines,
    wastage: input.wastageRows,
    warnings,
  }

  return {
    k,
    item: { before, after, eachMeasure, densityGPerMl },
    boxes: boxes.map(({ box, packChain, pricing }) => ({
      id: box.id,
      supplierName: box.supplierName,
      isPrimary: box.isPrimary,
      before: {
        packChain: box.packChain ?? null,
        pricing: box.pricing ?? null,
        packQty: box.packQty ?? null,
        packSize: box.packSize ?? null,
        packUOM: box.packUOM ?? null,
      },
      packChain,
      pricing,
    })),
    receipts,
    counts,
    stock,
    sessions,
    transfers,
    summary,
    errors,
  }
}
