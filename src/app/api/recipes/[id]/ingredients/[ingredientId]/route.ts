import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepToInventory } from '@/lib/recipeCosts'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; ingredientId: string } }
) {
  const body = await req.json()
  const { qtyBase, unit, notes, sortOrder, recipePercent, inventoryItemId } = body

  await prisma.recipeIngredient.update({
    where: { id: params.ingredientId },
    data: {
      ...(qtyBase !== undefined ? { qtyBase: parseFloat(qtyBase) } : {}),
      ...(unit !== undefined ? { unit } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      ...(recipePercent !== undefined ? { recipePercent: recipePercent !== null ? parseFloat(recipePercent) : null } : {}),
      ...(inventoryItemId !== undefined ? { inventoryItemId, linkedRecipeId: null } : {}),
    },
  })

  // Fire sync in background — don't block the response.
  // The client already shows the correct cost via optimistic update.
  const costAffecting = qtyBase !== undefined || unit !== undefined || inventoryItemId !== undefined
  if (costAffecting) syncPrepToInventory(params.id).catch(console.error)

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; ingredientId: string } }
) {
  await prisma.recipeIngredient.delete({ where: { id: params.ingredientId } })

  // Fire sync in background — don't block the response.
  syncPrepToInventory(params.id).catch(console.error)

  return NextResponse.json({ ok: true })
}
