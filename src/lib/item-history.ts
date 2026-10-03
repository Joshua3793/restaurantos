// "Does this item have history?" — the one question the edit rules ask before
// letting a manager change what the item IS (its measure) or how it is priced.
// Frozen numbers (count lines, snapshots, receipts, wastage, transfers) are in
// the item's base unit; recipe lines convert through it; a second box means
// another supplier's pack is expressed in it. Any of those makes a measure
// change a data rewrite, which is Stage 2c's guided flow, never a plain save.
import { prisma } from '@/lib/prisma'
import { dimensionOf } from '@/lib/item-model'

export interface ItemHistory {
  counts: number; snapshots: number; receipts: number; recipeLines: number
  wastage: number; transfers: number; offers: number
}

export async function itemHistory(itemId: string): Promise<ItemHistory> {
  const [counts, snapshots, receipts, recipeLines, wastage, transfers, offers] = await Promise.all([
    prisma.countLine.count({ where: { inventoryItemId: itemId } }),
    prisma.inventorySnapshot.count({ where: { inventoryItemId: itemId } }),
    prisma.invoiceScanItem.count({ where: { matchedItemId: itemId, approved: true } }),
    prisma.recipeIngredient.count({ where: { inventoryItemId: itemId } }),
    prisma.wastageLog.count({ where: { inventoryItemId: itemId } }),
    prisma.stockTransfer.count({ where: { inventoryItemId: itemId } }),
    prisma.inventorySupplierPrice.count({ where: { inventoryItemId: itemId } }),
  ])
  return { counts, snapshots, receipts, recipeLines, wastage, transfers, offers }
}

export function hasHistory(h: ItemHistory): boolean {
  return h.counts > 0 || h.snapshots > 0 || h.receipts > 0 || h.recipeLines > 0
    || h.wastage > 0 || h.transfers > 0 || h.offers >= 2
}

/** Recipes whose line on this item is in another dimension than the item's base —
 *  they cost ONLY through the item's each-measure, and read $0 (dimension conflict)
 *  the moment it is removed. */
export async function bridgeUsedBy(itemId: string): Promise<{ id: string; name: string; type: string }[]> {
  const item = await prisma.inventoryItem.findUnique({ where: { id: itemId }, select: { baseUnit: true, dimension: true } })
  if (!item) return []
  const lines = await prisma.recipeIngredient.findMany({
    where: { inventoryItemId: itemId },
    select: { unit: true, recipe: { select: { id: true, name: true, type: true } } },
  })
  const seen = new Map<string, { id: string; name: string; type: string }>()
  for (const l of lines) {
    if (dimensionOf(l.unit) === item.dimension) continue
    const crossesCount = item.dimension === 'COUNT' || dimensionOf(l.unit) === 'COUNT'
    if (crossesCount && !seen.has(l.recipe.id)) seen.set(l.recipe.id, l.recipe)
  }
  return Array.from(seen.values())
}
