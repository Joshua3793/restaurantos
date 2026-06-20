import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepItemFromRecipe } from '@/lib/prep-sync'

export const dynamic = 'force-dynamic'

export async function POST() {
  const prepRecipes = await prisma.recipe.findMany({
    where: { type: 'PREP', isActive: true },
    select: { id: true, prepItems: { select: { id: true }, take: 1 } },
  })

  let created = 0
  for (const r of prepRecipes) {
    const hadPrepItem = r.prepItems.length > 0
    await syncPrepItemFromRecipe(r.id)
    if (!hadPrepItem) created++
  }

  return NextResponse.json({ created, synced: prepRecipes.length })
}
