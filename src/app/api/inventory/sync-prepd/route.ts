import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepToInventory } from '@/lib/recipeCosts'
import { dimensionOf } from '@/lib/item-model'

/**
 * POST /api/inventory/sync-prepd
 * Pulls PREP recipes into Inventory:
 *  1. Backfill — every ACTIVE PREP recipe with no linked InventoryItem gets a
 *     PREPD inventory item created (find-or-create by name) and linked. Mirrors
 *     the auto-link the recipe-create route does, so prep recipes that predate it
 *     (or were imported) finally appear in inventory.
 *  2. Sync — recompute every linked PREP recipe's cost back to its InventoryItem.
 * Call after bulk imports or whenever PREPD items are missing / prices look stale.
 */
export async function POST() {
  // ── 1. Backfill missing inventory links for active PREP recipes ────────────
  const unlinked = await prisma.recipe.findMany({
    where: { type: 'PREP', isActive: true, inventoryItemId: null },
    select: { id: true, name: true, yieldUnit: true, baseYieldQty: true },
  })

  let created = 0
  for (const r of unlinked) {
    const yieldUnit = r.yieldUnit || 'each'
    const existing = await prisma.inventoryItem.findFirst({
      where: { itemName: r.name, category: 'PREPD' },
    })
    const invItem = existing ?? await prisma.inventoryItem.create({
      data: {
        itemName: r.name,
        category: 'PREPD',
        purchasePrice: 0,
        baseUnit: yieldUnit,
        stockOnHand: 0,
        // Chain placeholder — syncPrepToInventory fills in the real cost/yield.
        dimension: dimensionOf(yieldUnit),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        packChain: [{ unit: yieldUnit, per: Number(r.baseYieldQty) > 0 ? Number(r.baseYieldQty) : 1 }] as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pricing: { mode: 'PACK', purchasePrice: 0 } as any,
        countUnit: yieldUnit,
      },
    })
    await prisma.recipe.update({ where: { id: r.id }, data: { inventoryItemId: invItem.id } })
    if (!existing) created++
  }

  // ── 2. Sync cost for every linked PREP recipe (existing + newly linked) ─────
  const prepRecipes = await prisma.recipe.findMany({
    where: { type: 'PREP', inventoryItemId: { not: null } },
    select: { id: true, name: true },
  })

  // Run in bounded-concurrency batches: ~6× faster than sequential while staying
  // well under the pgBouncer transaction-pool connection limit (13).
  const results: { name: string; ok: boolean; error?: string }[] = new Array(prepRecipes.length)
  const CONCURRENCY = 6
  let cursor = 0
  const worker = async () => {
    while (cursor < prepRecipes.length) {
      const idx = cursor++
      const recipe = prepRecipes[idx]
      try {
        await syncPrepToInventory(recipe.id)
        results[idx] = { name: recipe.name, ok: true }
      } catch (err) {
        results[idx] = { name: recipe.name, ok: false, error: String(err) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, prepRecipes.length) }, worker))

  const succeeded = results.filter(r => r.ok).length
  const failed    = results.filter(r => !r.ok).length

  return NextResponse.json({ created, linked: unlinked.length, synced: succeeded, failed, results })
}
