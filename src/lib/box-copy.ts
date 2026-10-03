// Plain-English copy for the drawer's supplier boxes (pure — unit-tested).

/** The confirm sentence before a supplier box is removed. What happens to the
 *  item's price depends on whether the box is the main one and on what is left:
 *  removing the main box promotes the most recently updated other box; removing
 *  the last box leaves the item's own price as it was. */
export function removeBoxMessage({ supplierName, itemName, isPrimary, otherBoxes }: {
  supplierName: string
  itemName: string
  isPrimary: boolean
  /** Boxes the item keeps after this one is removed. */
  otherBoxes: number
}): string {
  const ask = `Remove ${supplierName}'s box for ${itemName}?`
  if (otherBoxes === 0) return `${ask} The item keeps its current price until a new box or invoice sets one.`
  if (isPrimary) return `${ask} The next most recent box becomes main.`
  return `${ask} Recipes keep costing from the main box.`
}
