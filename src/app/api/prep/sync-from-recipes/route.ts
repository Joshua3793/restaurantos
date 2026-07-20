import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { syncPrepItemFromRecipe } from '@/lib/prep-sync'

export const dynamic = 'force-dynamic'

export async function POST() {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

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
