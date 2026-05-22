import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepToInventory, fetchRecipeWithCost } from '@/lib/recipeCosts'

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

  // Only sync when cost-affecting fields change.
  // sortOrder, notes, recipePercent do not affect cost.
  const costAffecting = qtyBase !== undefined || unit !== undefined || inventoryItemId !== undefined
  if (costAffecting) await syncPrepToInventory(params.id)

  // Return the full updated recipe so the client can update state without an extra fetch.
  const recipe = await fetchRecipeWithCost(params.id)
  return NextResponse.json(recipe)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; ingredientId: string } }
) {
  await prisma.recipeIngredient.delete({ where: { id: params.ingredientId } })
  await syncPrepToInventory(params.id)
  // Return the full updated recipe so the client can update state without an extra fetch.
  const recipe = await fetchRecipeWithCost(params.id)
  return NextResponse.json(recipe)
}
