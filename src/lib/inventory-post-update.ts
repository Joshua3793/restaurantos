import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepToInventory, propagatePrepCostChanges } from '@/lib/recipeCosts'
import { listedPrice, withLastCost } from '@/lib/cost-basis'
import { PRIMARY_SUPPLIER_INCLUDE, withSupplier } from '@/lib/item-supplier'

/**
 * Shared post-update side-effects for the inventory item edit routes (PUT
 * /api/inventory/[id] and PATCH /api/inventory/[id]/pricing). After any spine
 * write we must: re-sync the item's own PREP recipe,
 * propagate the price change to dependent PREP recipes, cascade allergen changes,
 * and return the final (possibly recipe-overridden) state.
 */
export async function postUpdate(
  id: string,
  prevAllergens: string[],
  newAllergensInput: string[] | undefined,
): Promise<NextResponse> {
  // If this item is the output of a PREP recipe, re-sync to override the
  // purchase-formula values with recipe-derived costs (preserves count unit).
  const linkedRecipe = await prisma.recipe.findFirst({
    where: { inventoryItemId: id, type: 'PREP' },
    select: { id: true },
  })
  if (linkedRecipe) {
    await syncPrepToInventory(linkedRecipe.id)
  }

  // A manual price edit is a spine write: propagate it to every PREP recipe that
  // uses this item (directly or transitively) so their costs don't go stale —
  // same reason the invoice-approve path does. Runs after the own-prep sync above
  // so a prep item's freshly-derived price also propagates to its parents.
  await propagatePrepCostChanges([id])

  // If allergens changed, cascade-sync every PREP recipe that uses this item
  // as an ingredient so their linked PREPD items stay up to date.
  const newAllergens: string[] = newAllergensInput ?? prevAllergens ?? []
  const allergensChanged =
    JSON.stringify([...(prevAllergens ?? [])].sort()) !==
    JSON.stringify([...newAllergens].sort())

  if (allergensChanged) {
    const affectedRecipes = await prisma.recipe.findMany({
      where: {
        type: 'PREP',
        inventoryItemId: { not: null },
        ingredients: { some: { inventoryItemId: id } },
      },
      select: { id: true },
    })
    await Promise.all(affectedRecipes.map(r => syncPrepToInventory(r.id)))
  }

  // Return the final state (may have been updated by recipe sync)
  const updated = await prisma.inventoryItem.findUnique({
    where: { id },
    include: { ...PRIMARY_SUPPLIER_INCLUDE, storageArea: true },
  })
  return NextResponse.json(updated ? { ...withLastCost(withSupplier(updated)), purchasePrice: listedPrice(updated) } : updated)
}
