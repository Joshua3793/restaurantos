/**
 * The pure planner behind `scripts/audit-create-new-shape.ts` and
 * `scripts/repair-create-new-shape.ts`.
 *
 * Four products were created from per-lb invoice lines before the create-new
 * seed knew about measure units (`src/lib/invoice/create-new-seed.ts`), so each
 * was born as `COUNT / [{lb:1}] / RATE $/each` — or, for Kohlrabi, MASS with a
 * chain claiming 1 lb = 1 g. Everything downstream was then FROZEN through that
 * shape: `InvoiceScanItem.receivedQtyBase` and `CountLine.countedQtyBase` (with
 * the `InventorySnapshot` rows finalize wrote from them).
 *
 * Nothing here re-implements a conversion. Receipts go back through
 * `lineReceived` (the one receiving rule) and counts through `lineCountedBase`
 * (the one count rule) against the CORRECTED item, which is the whole point: the
 * repaired numbers are the numbers the app would have frozen had the item been
 * born right. Pure + client-safe — no Prisma, no I/O.
 */

import { canonicalUom, UNIT_FACTORS } from '@/lib/uom'
import {
  asChainItem, dimensionOf,
  type ChainItem, type Dimension, type PackLink, type Pricing,
} from '@/lib/item-model'
import { lineReceived, type LineQtyInput } from '@/lib/invoice/line-qty'
import { cloneShare } from '@/lib/invoice/refreeze'
import { lineCountedBase, countUomFactor, type ItemDims } from '@/lib/count-uom'

/** An InventoryItem row as `asChainItem` accepts it. */
export type ChainItemRow = Parameters<typeof asChainItem>[0]

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

/** A weight/volume unit the canonical table knows — never a count or container. */
function measureFactor(unit: string | null | undefined): { dim: 'weight' | 'volume'; toBase: number } | null {
  if (!unit) return null
  const f = UNIT_FACTORS[canonicalUom(unit)]
  return f && f.dim !== 'count' ? { dim: f.dim, toBase: f.toBase } : null
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Is an item's own shape internally contradictory?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reasons an item's four pricing fields contradict each other — `[]` when they
 * agree. Deliberately conservative: it reads ONLY the item, so it can be run
 * over the whole catalogue without drowning the audit.
 *
 * Note what it does NOT catch: Fennel O/S (`COUNT / [{each:1}] / RATE $/each`)
 * is a perfectly ordinary COUNT item on these fields alone — it is only wrong
 * relative to the per-lb line that created it. The audit script therefore also
 * looks at by-weight purchase evidence; flagging every COUNT item priced $/each
 * here would bury the real findings under hundreds of healthy rows.
 */
export function isSelfContradictory(item: {
  dimension: string
  baseUnit: string | null
  packChain: unknown
  pricing: unknown
}): string[] {
  const reasons: string[] = []
  const chain = Array.isArray(item.packChain) ? (item.packChain as PackLink[]) : []
  const dim = String(item.dimension ?? '').trim().toUpperCase()
  const baseUnit = canonicalUom(item.baseUnit ?? '')
  const measureLinks = chain.filter((l) => measureFactor(l?.unit) !== null)

  // A COUNT item counts things; a link measured in lb/kg/l is a weight purchase
  // wearing a count item's clothes.
  if (dim === 'COUNT' && measureLinks.length > 0) reasons.push('COUNT with a measure-unit chain link')

  // $/each on an item whose pack is measured: the price is really $/lb, and every
  // cost read off it is out by the weight of one unit.
  const pricing = item.pricing && typeof item.pricing === 'object' ? (item.pricing as Pricing) : null
  if (pricing?.mode === 'RATE' && dimensionOf(canonicalUom(pricing.rateUnit ?? '')) === 'COUNT' && measureLinks.length > 0) {
    reasons.push('RATE per each')
  }

  // `1 lb = 1 base unit` — the signature of a chain built by a form that never
  // saw the line's measure unit. A link naming the base unit itself (g per 1) is
  // the legitimate version of this and is left alone.
  if (chain.some((l) => measureFactor(l?.unit) !== null && num(l?.per) === 1 && canonicalUom(l.unit) !== baseUnit)) {
    reasons.push('measure link per 1')
  }

  return reasons
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The corrected item
// ─────────────────────────────────────────────────────────────────────────────

export interface ItemRewrite {
  dimension: 'MASS' | 'VOLUME'
  baseUnit: 'g' | 'ml'
  packChain: PackLink[]
  pricing: Pricing
  countUnit: string
}

/**
 * The shape the item should have been born with, given the measure unit its
 * invoice line was billed in — field for field the same thing `formToChain`
 * produces from the by-weight seed (global-constraints.md), so the repaired item
 * is indistinguishable from one created correctly today.
 *
 * The RATE NUMBER is never touched: $1.99 was always $1.99 per lb: only the unit
 * it was labelled with was wrong. A PACK price carries over as that rate for the
 * same reason — it was the per-measure price the line was seeded from.
 */
export function planItemRewrite(a: { item: ChainItemRow; measure: string }): ItemRewrite {
  const measure = canonicalUom(a.measure)
  const f = measureFactor(measure)
  if (!f) throw new Error(`planItemRewrite: "${a.measure}" is not a weight/volume unit — there is nothing to convert through.`)

  const ci = asChainItem(a.item)
  const rate = ci.pricing?.mode === 'RATE' ? num(ci.pricing.rate) : num((ci.pricing as { purchasePrice?: unknown })?.purchasePrice)

  return {
    dimension: f.dim === 'weight' ? 'MASS' : 'VOLUME',
    baseUnit: f.dim === 'weight' ? 'g' : 'ml',
    packChain: [{ unit: measure, per: f.toBase }],
    pricing: { mode: 'RATE', rate, rateUnit: measure },
    countUnit: measure,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Receipts
// ─────────────────────────────────────────────────────────────────────────────

export interface ReceiptLine extends LineQtyInput {
  id: string
  /** Set when this row is an RC split clone: the id of the line it was copied
   *  from. A clone is a SHARE of its parent's value, never the rule's output. */
  parentLineId?: string | null
}

export interface ReceiptRefreezeRow {
  id: string
  old: number | null
  next: number
  via: string
}

/** A line's receiving inputs with the FROZEN receipt cleared — mirrors
 *  `lineQtyOf` in api/invoices/sessions/[id]/approve. Passing the stored value
 *  back in makes `lineReceived` answer `via: 'frozen'`, which would make this
 *  repair a no-op on exactly the rows it exists to fix. */
export function lineQtyOf(line: ReceiptLine): LineQtyInput {
  return { ...line, receivedQtyBase: null }
}

/**
 * Every line's receipt recomputed against the corrected item. Rows come back in
 * input order, changed or not — the caller decides what is material.
 */
export function planReceiptRefreeze(lines: ReceiptLine[], corrected: ChainItem): ReceiptRefreezeRow[] {
  const byId = new Map(lines.map((l) => [l.id, l]))
  const computed = new Map<string, { base: number; via: string }>()
  for (const l of lines) {
    if (l.parentLineId) continue
    const got = lineReceived(lineQtyOf(l), corrected)
    computed.set(l.id, { base: got.base, via: got.via })
  }

  return lines.map((l) => {
    const old = l.receivedQtyBase != null ? num(l.receivedQtyBase) : null
    if (!l.parentLineId) {
      const got = computed.get(l.id)!
      return { id: l.id, old, next: got.base, via: got.via }
    }
    const parent = byId.get(l.parentLineId)
    const parentNext = parent ? computed.get(parent.id) : undefined
    const share = parent && parentNext ? cloneShare(parent.rawLineTotal, l.rawLineTotal) : null
    if (parent && parentNext && share !== null) {
      return { id: l.id, old, next: parentNext.base * share, via: `clone of ${parentNext.via}` }
    }
    // No parent in this run, or totals that can't honestly be shared: leave the
    // frozen value exactly as it is and say so, rather than guessing a share.
    return { id: l.id, old, next: old ?? 0, via: 'orphan clone — unchanged' }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Count lines (+ their snapshots)
// ─────────────────────────────────────────────────────────────────────────────

export interface CountLineRow {
  id: string
  countedQty: number | string | null
  selectedUom: string
  entries?: unknown
  countedQtyBase?: number | string | null
  skipped?: boolean
  /** The finalize-time snapshot frozen from this line, when the session was
   *  finalized. `qtyOnHand` is carried so the planner can PROVE the snapshot
   *  came from this line before rewriting it. */
  snapshot?: { id: string; qtyOnHand: number | string } | null
  /** A human's decision for a line the corrected item cannot resolve
   *  (`--count-unit-override <lineId>=<unit>`). */
  unitOverride?: string | null
}

export interface CountRefreezeRow {
  id: string
  old: number | null
  next: number
  via: string
  /** The corrected item gives this line's unit no meaning and the quantity is
   *  not zero — `lineCountedBase` fell back to a 1:1 passthrough, which is a
   *  number, not an answer. A human picks the unit. */
  needsDecision: boolean
  snapshot?: { id: string; qtyOnHand: number; unit: string; pricePerBaseUnit: number; totalValue: number }
  /** The line HAS a snapshot, but its stored qtyOnHand isn't this line's frozen
   *  base — so it wasn't written from this line (or has been repaired already)
   *  and is left untouched. */
  snapshotMismatch?: boolean
}

/** `ItemDims` for the count converters, built from the corrected ChainItem so a
 *  hand-written literal can't drop the each-measure bridge. */
function dimsOf(item: ChainItem): ItemDims {
  return {
    dimension: item.dimension,
    baseUnit: item.baseUnit,
    packChain: item.packChain,
    countUnit: item.countUnit ?? null,
    eachMeasureQty: item.eachMeasure?.qty ?? null,
    eachMeasureUnit: item.eachMeasure?.unit ?? null,
  }
}

const entriesOf = (v: unknown): { unit?: unknown; qty?: unknown }[] | null => {
  const arr = Array.isArray(v) ? (v as { unit?: unknown; qty?: unknown }[]) : null
  return arr && arr.length > 0 ? arr : null
}

/**
 * Every count line's frozen base recomputed against the corrected item, plus the
 * snapshot row finalize wrote from it.
 *
 * `countedQtyBase` is passed as `null` on purpose (count-uom.ts: the frozen value
 * otherwise wins outright) — re-deriving is the repair. `ppb` is the corrected
 * item's `pricePerBaseUnit`; `totalValue = qtyBase × ppb` and `unit = baseUnit`,
 * exactly as `src/lib/count-finalize.ts` writes them.
 */
export function planCountRefreeze(lines: CountLineRow[], corrected: ChainItem, ppb: number): CountRefreezeRow[] {
  const dims = dimsOf(corrected)

  return lines.map((line) => {
    const old = line.countedQtyBase != null ? num(line.countedQtyBase) : null
    const entries = entriesOf(line.entries)
    const override = line.unitOverride ? canonicalUom(line.unitOverride) : null

    // Skipped / never-counted lines carry no observation to re-freeze. Their
    // snapshots (SKIPPED / THEORETICAL) are not this repair's business.
    if (line.skipped || line.countedQty == null) {
      return { id: line.id, old, next: old ?? 0, via: 'not counted', needsDecision: false }
    }

    let next: number
    let via: string
    let needsDecision = false

    if (override && entries) {
      // One unit can't stand in for a mixed-unit count without inventing which
      // entry it applies to. Refuse and keep asking.
      return { id: line.id, old, next: old ?? 0, via: `override refused — mixed-unit entries`, needsDecision: true }
    }

    if (override) {
      next = lineCountedBase({ countedQty: line.countedQty, selectedUom: override, countedQtyBase: null }, dims)
      via = `override ${num(line.countedQty)} ${override}`
      needsDecision = countUomFactor(override, dims) === null && num(line.countedQty) !== 0
    } else {
      next = lineCountedBase(
        { entries: line.entries, countedQty: line.countedQty, selectedUom: line.selectedUom, countedQtyBase: null },
        dims,
      )
      via = entries ? `entries(${entries.length})` : `${num(line.countedQty)} ${line.selectedUom}`
      const parts = entries
        ? entries.map((e) => ({ unit: String(e?.unit ?? ''), qty: num(e?.qty) }))
        : [{ unit: line.selectedUom, qty: num(line.countedQty) }]
      // Zero of an unresolvable unit is still zero — there is nothing to decide.
      needsDecision = parts.some((p) => p.qty !== 0 && countUomFactor(p.unit, dims) === null)
    }

    const row: CountRefreezeRow = { id: line.id, old, next, via, needsDecision }

    if (line.snapshot) {
      const stored = num(line.snapshot.qtyOnHand)
      const matches = old != null && Math.abs(stored - old) <= Math.max(1e-6, Math.abs(old) * 1e-6)
      if (matches) {
        row.snapshot = {
          id: line.snapshot.id,
          qtyOnHand: next,
          unit: corrected.baseUnit,
          pricePerBaseUnit: ppb,
          totalValue: next * ppb,
        }
      } else {
        row.snapshotMismatch = true
      }
    }

    return row
  })
}

/** Convenience for callers that only want the rows that actually move. */
export function isMaterial(old: number | null, next: number): boolean {
  const prev = old ?? 0
  if (prev === 0) return Math.abs(next) > 1e-9
  return Math.abs(next - prev) > Math.max(1e-6, Math.abs(prev) * 1e-9)
}

export type { ChainItem, Dimension, PackLink, Pricing }
