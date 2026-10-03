// Which record "Use the invoice's format" changes. An item with supplier boxes
// is priced on its main box, so the invoice's pack and price belong on the
// INVOICE SUPPLIER's box — picked by the same rule the review screen reads the
// line through (`pickOffer`). Only a box-less item changes its own pack and
// price. Pure + client-safe.

import { pickOffer } from '@/lib/invoice/line-format'

export interface AdoptBox {
  id: string
  supplierId: string | null
  supplierItemCode?: string | null
  isPrimary?: boolean | null
}

export type AdoptTarget =
  | { kind: 'item' }
  | { kind: 'box'; offerId: string; isPrimary: boolean }
  | { kind: 'new-box' }
  | { kind: 'unlinked' }

export function adoptTarget({ offers, supplierId, itemCode }: {
  offers: AdoptBox[]
  supplierId: string | null | undefined
  itemCode?: string | null
}): AdoptTarget {
  if (offers.length === 0) return { kind: 'item' }
  if (!supplierId) return { kind: 'unlinked' }
  const box = pickOffer(offers, { supplierId, itemCode })
  return box ? { kind: 'box', offerId: box.id, isPrimary: !!box.isPrimary } : { kind: 'new-box' }
}
