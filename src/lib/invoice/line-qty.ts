// Received-quantity math for an invoice line — the "total" an RC split must sum to.
// Mirrors the purchase-quantity logic in count-expected.ts so the split editor,
// approve-time validation, and theoretical receiving all agree. Pure + client-safe.

import { convertQty, canonicalUom, UNIT_FACTORS } from '@/lib/uom'
import { asChainItem, basePerUnit, type ChainItem } from '@/lib/item-model'
import { convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'

/** Fields of a scan line that determine how much was received. */
export interface LineQtyInput {
  rawQty?: number | string | null
  rawUnit?: string | null
  totalQty?: number | string | null
  totalQtyUOM?: string | null
  invoicePackQty?: number | string | null
  invoicePackSize?: number | string | null
  invoicePackUOM?: string | null
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

/** Base units (g/ml/each) received by a line, for the line's matched item.
 *  Identical rule to buildPurchaseMap in count-expected.ts. */
export function lineReceivedBaseUnits(line: LineQtyInput, chainItem: ChainItem): number {
  const qty = num(line.rawQty)
  if (qty <= 0) return 0
  const baseUnit = chainItem.baseUnit
  const isRate = chainItem.pricing?.mode === 'RATE'

  if (isRate) {
    let billedQty = qty
    let billedUOM: string | null
    if (num(line.totalQty) > 0) { billedQty = num(line.totalQty); billedUOM = line.totalQtyUOM ?? baseUnit }
    else { billedQty = qty; billedUOM = line.rawUnit ?? baseUnit }
    if (billedUOM && UNIT_FACTORS[canonicalUom(billedUOM)]) {
      return convertQty(billedQty, billedUOM, baseUnit)
    }
  }

  // CASE pricing (or a RATE line billed in a container unit): expand via pack.
  const packQty  = num(line.invoicePackQty)
  const packSize = num(line.invoicePackSize)
  const packUOM  = line.invoicePackUOM ?? null
  if (packQty > 0 && packSize > 0 && packUOM) {
    return convertQty(qty * packQty * packSize, packUOM, baseUnit)
  }
  const top = chainItem.packChain?.[0]?.unit
  const perCase = top ? basePerUnit(chainItem, top) : 1
  return qty * perCase
}

/** Matched-item row shape (Prisma JSON-serialised) needed to resolve units. */
export interface MatchedItemLike {
  dimension: string
  baseUnit: string | null
  packChain: unknown
  pricing: unknown
  countUnit: string | null
}

/** Received quantity expressed in the item's COUNT UOM — the number the split
 *  must add up to. Returns { qty, countUom }. */
export function lineReceivedCountQty(line: LineQtyInput, matched: MatchedItemLike): { qty: number; countUom: string } {
  const chainItem = asChainItem({
    dimension: matched.dimension,
    baseUnit:  matched.baseUnit ?? 'each',
    packChain: matched.packChain,
    pricing:   matched.pricing,
    countUnit: matched.countUnit ?? undefined,
  })
  const dims = { dimension: matched.dimension, baseUnit: matched.baseUnit ?? 'each', packChain: matched.packChain, countUnit: matched.countUnit }
  const countUom = resolveCountUom(dims) || chainItem.baseUnit
  const base = lineReceivedBaseUnits(line, chainItem)
  return { qty: convertBaseToCountUom(base, countUom, dims), countUom }
}
