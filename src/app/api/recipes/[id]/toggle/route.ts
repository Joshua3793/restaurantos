import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepItemFromRecipe } from '@/lib/prep-sync'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function PATCH(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const recipe = await prisma.recipe.findUnique({ where: { id: params.id }, select: { isActive: true } })
  if (!recipe) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updated = await prisma.recipe.update({
    where: { id: params.id },
    data: { isActive: !recipe.isActive },
    select: { id: true, isActive: true },
  })

  // Mirror the recipe's active state onto its linked prep task row.
  await syncPrepItemFromRecipe(params.id).catch(e => console.error('[recipe toggle] prep-item sync', e))

  return NextResponse.json(updated)
}
