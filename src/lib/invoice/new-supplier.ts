import type { ScanItem } from '@/components/invoices/types'
import { offerForSupplier, type SupplierRef } from '@/lib/invoice/resolution'

/** This line brings a supplier the matched item has never been bought from. */
export function isNewSupplierForItem(item: ScanItem, ref: SupplierRef): boolean {
  if (!item.matchedItem || item.action === 'SKIP' || item.action === 'CREATE_NEW') return false
  if (!ref.supplierId && !ref.supplierName && !ref.canonicalName) return false
  const offers = item.matchedItem.supplierPrices ?? []
  return offers.length > 0 && !offerForSupplier(item, ref)
}
