import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepToInventory } from '@/lib/recipeCosts'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; ingredientId: string } }
) {
  const body = await req.json()
  const { qtyBase, unit, notes, sortOrder, recipePercent, inventoryItemId } = body

  const updated = await prisma.recipeIngredient.update({
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

  await syncPrepToInventory(params.id)
  return NextResponse.json(updated)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; ingredientId: string } }
) {
  await prisma.recipeIngredient.delete({ where: { id: params.ingredientId } })
  await syncPrepToInventory(params.id)
  return NextResponse.json({ success: true })
}
