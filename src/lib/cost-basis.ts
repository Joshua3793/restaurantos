// The recipe/menu cost basis: what a base unit of an item actually cost us over
// the last COST_WINDOW_DAYS, pooled across every supplier — Σ line total ÷ Σ
// frozen received quantity over the approved invoice lines in the window.
// Derived at read time, never stored (a cached cost is the divergence class the
// spine was cleaned of). Everything outside the recipe/menu surfaces keeps the
// last price: `pricePerBaseUnit(item)`.
import { prisma } from '@/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'
import { IMPLAUSIBLE_PRICE_RATIO } from '@/lib/invoice/line-format'

export const COST_WINDOW_DAYS = 30
export type CostBasis = 'AVG_30D' | 'LAST'

export interface ItemCostBasis {
  basis: CostBasis
  /** $/base-unit on the chosen basis. On 'LAST' this equals pricePerBaseUnit(item). */
  pricePerBase: number
  /** The average's evidence — present whenever ≥ 1 line was looked at, even when the guard fell back. */
  avg?: { pricePerBase: number; paid: number; received: number; lines: number; excluded: number }
  /** Why an item is NOT on the average. */
  fallbackReason?: 'no-purchases' | 'implausible'
}

export interface CostLine { rawLineTotal: unknown; receivedQtyBase: unknown }

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN }

/**
 * Fold one item's qualifying lines. A line contributes to BOTH sums or to
 * neither: a credit, an unpriced line (Veal Bones with no price must not drag
 * the average toward $0) or a never-frozen receipt is excluded and counted.
 */
export function foldCostBasis(a: { lines: CostLine[]; lastPricePerBase: number }): ItemCostBasis {
  const last = Number(a.lastPricePerBase) > 0 ? Number(a.lastPricePerBase) : 0
  let paid = 0, received = 0, lines = 0, excluded = 0
  for (const l of a.lines) {
    const t = num(l.rawLineTotal), q = num(l.receivedQtyBase)
    if (t > 0 && q > 0) { paid += t; received += q; lines++ } else excluded++
  }
  if (a.lines.length === 0) return { basis: 'LAST', pricePerBase: last, fallbackReason: 'no-purchases' }
  if (lines === 0) return { basis: 'LAST', pricePerBase: last, fallbackReason: 'no-purchases', avg: { pricePerBase: 0, paid, received, lines, excluded } }
  const avgPpb = paid / received
  const avg = { pricePerBase: avgPpb, paid, received, lines, excluded }
  // A historically mis-frozen receipt (a g↔kg slip) must not poison every recipe
  // using the item — the same ratio that disqualifies an offer's pricing.
  const implausible = last > 0 && (avgPpb / last > IMPLAUSIBLE_PRICE_RATIO || last / avgPpb > IMPLAUSIBLE_PRICE_RATIO)
  if (implausible) return { basis: 'LAST', pricePerBase: last, fallbackReason: 'implausible', avg }
  return { basis: 'AVG_30D', pricePerBase: avgPpb, avg }
}

/**
 * Purchases dated within the 30 days before now — the start day counted whole.
 *
 * `purchaseDate` is the invoice's own calendar date stored at UTC midnight
 * (`parseInvoiceDate`), so the lower bound is floored to UTC midnight: an invoice
 * dated exactly 30 days ago is IN, whatever time of day `asOf` is. The window is
 * therefore up to 31 calendar days wide, which is the point — a day is either
 * wholly in or wholly out, never half-counted by the clock.
 */
export function costWindow(asOf: Date): { gte: Date; lte: Date } {
  const gte = new Date(asOf.getTime() - COST_WINDOW_DAYS * 86_400_000)
  gte.setUTCHours(0, 0, 0, 0)
  return { gte, lte: asOf }
}

/**
 * ONE read for many items. Every non-PREP id passed in gets an entry; PREP-linked
 * items are never averaged (their cost is the recipe's computed cost) and get none.
 */
export async function windowedAvgCost(itemIds: string[], asOf: Date = new Date()): Promise<Map<string, ItemCostBasis>> {
  const out = new Map<string, ItemCostBasis>()
  const ids = Array.from(new Set(itemIds))
  if (ids.length === 0) return out
  const [items, rows] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { id: { in: ids }, recipe: null },
      select: { id: true, ...PRICING_SELECT },
    }),
    prisma.invoiceScanItem.findMany({
      where: {
        matchedItemId: { in: ids },
        approved: true,
        splitToSessionId: null, // RC-split parents out; their clones sum to the parent (same filter as periodPurchases)
        session: { status: 'APPROVED', purchaseDate: costWindow(asOf) },
      },
      select: { matchedItemId: true, rawLineTotal: true, receivedQtyBase: true },
    }),
  ])
  const byItem = new Map<string, CostLine[]>()
  for (const r of rows) {
    if (!r.matchedItemId) continue
    const arr = byItem.get(r.matchedItemId) ?? []
    arr.push(r)
    byItem.set(r.matchedItemId, arr)
  }
  for (const it of items) {
    out.set(it.id, foldCostBasis({ lines: byItem.get(it.id) ?? [], lastPricePerBase: pricePerBaseUnit(asChainItem(it)) }))
  }
  return out
}
