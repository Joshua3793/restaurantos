import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepToInventory } from '@/lib/recipeCosts'

/**
 * POST /api/inventory/sync-prepd
 * Re-syncs ALL PREP recipes to their linked InventoryItems.
 * Call this after bulk data imports or whenever PREPD prices look stale.
 */
export async function POST() {
  const prepRecipes = await prisma.recipe.findMany({
    where: { type: 'PREP', inventoryItemId: { not: null } },
    select: { id: true, name: true },
  })

  const results: { name: string; ok: boolean; error?: string }[] = []

  for (const recipe of prepRecipes) {
    try {
      await syncPrepToInventory(recipe.id)
      results.push({ name: recipe.name, ok: true })
    } catch (err) {
      results.push({ name: recipe.name, ok: false, error: String(err) })
    }
  }

  const succeeded = results.filter(r => r.ok).length
  const failed    = results.filter(r => !r.ok).length

  return NextResponse.json({ synced: succeeded, failed, results })
}
