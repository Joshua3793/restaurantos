// The inventory item a PREP recipe makes. Every new PREP recipe gets one (found
// by name in PREPD, or created), so it can be used as an ingredient elsewhere.
// Shared by POST /api/recipes and the Recipe Scan save; `db` is the prisma
// client or a transaction client.
import type { Prisma } from '@prisma/client'
import { dimensionOf } from '@/lib/item-model'

type Db = Pick<Prisma.TransactionClient, 'inventoryItem' | 'recipe'>

/**
 * Find-or-create the PREPD item named after the recipe and link the recipe to
 * it. `yieldUnit` must already be canonical. The chain written here is a
 * placeholder; `syncPrepToInventory` fills in the real cost and yield after.
 */
export async function linkPrepInventoryItem(
  db: Db,
  args: { recipeId: string; name: string; yieldUnit: string; baseYieldQty: number },
): Promise<{ id: string }> {
  const { recipeId, name, yieldUnit, baseYieldQty } = args
  const existing = await db.inventoryItem.findFirst({
    where: { itemName: name, category: 'PREPD' },
  })

  const invItem = existing
    ? await db.inventoryItem.update({
        where: { id: existing.id },
        data: { baseUnit: yieldUnit, lastUpdated: new Date() },
      })
    : await db.inventoryItem.create({
        data: {
          itemName: name,
          category: 'PREPD',
          baseUnit: yieldUnit,
          stockOnHand: 0,
          // Chain placeholder — syncPrepToInventory fills in the real cost/yield.
          dimension: dimensionOf(yieldUnit),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          packChain: [{ unit: yieldUnit, per: baseYieldQty || 1 }] as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pricing: { mode: 'PACK', purchasePrice: 0 } as any,
          countUnit: yieldUnit,
        },
      })

  await db.recipe.update({
    where: { id: recipeId },
    data: { inventoryItemId: invItem.id },
  })
  return { id: invItem.id }
}
