// THE reader-facing cost API. Every route and lib that needs "what does a base
// unit of this item cost" imports from HERE, on an explicit basis:
//   LAST    — the primary supplier's last price, derived from the item's
//             packChain + pricing (numerically the engine's pricePerBaseUnit).
//             Counts, stock value, COGS, variance, theoretical usage, orders.
//   AVG_30D — Σ line total ÷ Σ frozen receivedQtyBase over the approved invoice
//             lines of the last COST_WINDOW_DAYS, pooled across every supplier.
//             Recipes, menu, wastage. Falls back to LAST, labelled.
// Nothing here is stored (a cached cost is the divergence class the spine was
// cleaned of). `src/lib/item-model.ts` stays the pure engine; the gate test
// `src/lib/__tests__/cost-readers-gate.test.ts` keeps readers out of it.
import { prisma } from '@/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit, basePerPurchase, withPpb } from '@/lib/item-model'
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
  fallbackReason?: 'no-purchases' | 'implausible' | 'prep-linked'
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

/** A Prisma row loaded with `...PRICING_SELECT` (plus whatever else the caller selected). */
export type ChainRow = Parameters<typeof asChainItem>[0]

/** LAST basis, synchronous: the primary chain's $/base for a row already in hand. */
export function lastCost(row: ChainRow): number {
  return pricePerBaseUnit(asChainItem(row))
}

/** Attach a computed `pricePerBaseUnit` (LAST) for API responses that still expose the field. */
export function withLastCost<T extends ChainRow>(row: T): T & { pricePerBaseUnit: number } {
  return withPpb(row)
}

/**
 * LAST basis price of ONE top-of-chain (purchase) unit — the box price for a
 * PACK item; for a RATE item the rate × the base units one purchase unit holds
 * (a pound of $28.60/kg salmon is $12.97). Replaces every read of the legacy
 * `purchasePrice` column, which held the RATE itself for weight-priced items.
 */
export function purchaseUnitCost(row: ChainRow): number {
  const chain = asChainItem(row)
  return lastCost(row) * basePerPurchase(chain.packChain)
}

/**
 * The price as the primary supplier lists it, in the pricing's own mode: the
 * box price for PACK, the rate itself (e.g. $/kg) for RATE. This is the number
 * the legacy `purchasePrice` column held; use it wherever that column was read
 * as "the listed price" rather than "the price of one purchase unit".
 */
export function listedPrice(row: ChainRow): number {
  const p = asChainItem(row).pricing
  return p.mode === 'RATE' ? Number(p.rate || 0) : Number(p.purchasePrice || 0)
}

/** Batched: one cost per id on `basis`. Unknown ids are simply absent. */
export async function itemCosts(itemIds: string[], basis: CostBasis, asOf: Date = new Date()): Promise<Map<string, ItemCostBasis>> {
  const ids = Array.from(new Set(itemIds))
  if (ids.length === 0) return new Map()
  if (basis === 'LAST') {
    const rows = await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, ...PRICING_SELECT } })
    return new Map(rows.map((r) => [r.id, { basis: 'LAST' as const, pricePerBase: lastCost(r) }]))
  }
  const out = await windowedAvgCost(ids, asOf)
  // windowedAvgCost never averages a PREP output (its cost is the recipe's);
  // those ids come back on LAST, labelled, so a caller always gets an entry.
  const missing = ids.filter((id) => !out.has(id))
  if (missing.length > 0) {
    const rows = await prisma.inventoryItem.findMany({ where: { id: { in: missing } }, select: { id: true, ...PRICING_SELECT } })
    for (const r of rows) out.set(r.id, { basis: 'LAST', pricePerBase: lastCost(r), fallbackReason: 'prep-linked' })
  }
  return out
}

/** One item on `basis`; null when the id does not exist. */
export async function itemCost(itemId: string, basis: CostBasis, asOf: Date = new Date()): Promise<ItemCostBasis | null> {
  return (await itemCosts([itemId], basis, asOf)).get(itemId) ?? null
}
