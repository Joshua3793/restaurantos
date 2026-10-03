/**
 * Should approving this line re-price the ITEM (its packChain/pricing = the
 * primary supplier's box)? The primary is a sticky, manual choice: only the
 * primary's own box may move the item.
 *  • linked supplier, offer written      → only if that offer IS the primary
 *  • linked supplier, offer write failed → only if the primary belongs to this
 *                                          supplier and it sells the item as ONE product
 *  • unlinked supplier (no supplierId)   → only if the item has NO boxes at all
 *                                          (legacy single-supplier item); with any
 *                                          box present nothing is written — an
 *                                          unlinked invoice must never overwrite
 *                                          another supplier's price.
 */
export function shouldRepriceItem(a: {
  sessionSupplierId: string | null
  writtenOfferId: string | null
  primary: { id: string; supplierId: string } | null
  supplierRowCount: number
  itemOfferCount: number
}): boolean {
  if (!a.sessionSupplierId) return a.itemOfferCount === 0
  if (a.writtenOfferId) return a.primary?.id === a.writtenOfferId
  return a.supplierRowCount <= 1 && a.primary?.supplierId === a.sessionSupplierId
}

/**
 * Which box must be written equal to the item on this approve? When the item is
 * re-priced, its primary box must end with the item's chain + pricing:
 *  • the box this approve wrote, when the offer write succeeded
 *  • otherwise the primary box (the offer write failed but the item is still
 *    re-priced from its primary supplier)
 *  • nothing when the item is not re-priced.
 */
export function primaryBoxWrite(a: {
  shouldReprice: boolean
  writtenOfferId: string | null
  primaryId: string | null
}): { boxId: string | null } {
  if (!a.shouldReprice) return { boxId: null }
  return { boxId: a.writtenOfferId ?? a.primaryId ?? null }
}
