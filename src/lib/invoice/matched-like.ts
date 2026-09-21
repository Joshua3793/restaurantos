import type { InventoryMatch } from '@/components/invoices/types'
import type { MatchedItemLike } from '@/lib/invoice/line-qty'

/** The ONE mapping from the review UI's matched item to what receiving reads.
 *  Three call sites used to hand-build this object and all three dropped the
 *  item's bridges. */
export function matchedLikeOf(m: InventoryMatch): MatchedItemLike {
  return {
    dimension: m.dimension ?? 'COUNT',
    baseUnit:  m.baseUnit ?? 'each',
    packChain: m.packChain,
    pricing:   m.pricing,
    countUnit: m.countUnit ?? null,
    eachMeasureQty:  m.eachMeasureQty ?? null,
    eachMeasureUnit: m.eachMeasureUnit ?? null,
    densityGPerMl:   m.densityGPerMl ?? null,
  }
}
