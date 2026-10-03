import type { ScanItem } from '@/components/invoices/types'
import type { SupplierRef } from '@/lib/invoice/resolution'
import { supplierOffers } from '@/lib/invoice/line-format'

/** This line brings a supplier the matched item has never been bought from. */
export function isNewSupplierForItem(item: ScanItem, ref: SupplierRef): boolean {
  if (!item.matchedItem || item.action === 'SKIP' || item.action === 'CREATE_NEW') return false
  // Offers join on the supplier id alone: an unlinked supplier cannot be called new.
  if (!ref.supplierId) return false
  const offers = item.matchedItem.supplierPrices ?? []
  // Any offer from this supplier, whatever the SKU — a new SKU from a known
  // supplier is a new product, not a new supplier.
  return offers.length > 0 && supplierOffers(offers, ref).length === 0
}
