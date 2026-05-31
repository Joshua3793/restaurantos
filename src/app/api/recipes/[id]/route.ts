import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchRecipeWithCost, syncPrepToInventory } from '@/lib/recipeCosts'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const recipe = await fetchRecipeWithCost(params.id)
  if (!recipe) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const upstream = await prisma.recipeIngredient.findMany({
    where: { linkedRecipeId: params.id },
    select: { recipe: { select: { id: true, name: true, type: true } } },
  })
  const usedInRecipes = upstream
    .map(u => u.recipe)
    .filter((r, i, arr) => arr.findIndex(x => x.id === r.id) === i)

  return NextResponse.json({ ...recipe, usedInRecipes })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { name, categoryId, baseYieldQty, yieldUnit, portionSize, portionUnit, menuPrice, notes, isActive, baseIngredientId, steps } = body

  await prisma.recipe.update({
    where: { id: params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(baseYieldQty !== undefined ? { baseYieldQty: parseFloat(baseYieldQty) } : {}),
      ...(yieldUnit !== undefined ? { yieldUnit } : {}),
      ...(portionSize !== undefined ? { portionSize: portionSize ? parseFloat(portionSize) : null } : {}),
      ...(portionUnit !== undefined ? { portionUnit } : {}),
      ...(menuPrice !== undefined ? { menuPrice: menuPrice ? parseFloat(menuPrice) : null } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(baseIngredientId !== undefined ? { baseIngredientId: baseIngredientId ?? null } : {}),
      ...(Array.isArray(steps) ? { steps: steps.filter((s: unknown) => typeof s === 'string') } : {}),
    },
  })

  // Only sync to inventory when fields that affect cost change (yield quantity/unit).
  // name, notes, isActive, categoryId, menuPrice, portionSize/Unit do not affect cost.
  const costAffecting = baseYieldQty !== undefined || yieldUnit !== undefined
  if (costAffecting) await syncPrepToInventory(params.id)

  const updated = await fetchRecipeWithCost(params.id)
  return NextResponse.json(updated)
}

// Hard delete — cleans up references before removing the row
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id
  try {
    await prisma.$transaction(async tx => {
      await tx.recipeIngredient.updateMany({ where: { linkedRecipeId: id }, data: { linkedRecipeId: null } })
      await tx.saleLineItem.deleteMany({ where: { recipeId: id } })
      await tx.prepItem.updateMany({ where: { linkedRecipeId: id }, data: { linkedRecipeId: null } })
      await tx.recipeAlert.deleteMany({ where: { recipeId: id } })
      const recipe = await tx.recipe.findUnique({ where: { id }, select: { inventoryItemId: true } })
      if (recipe?.inventoryItemId) {
        await tx.inventoryItem.update({ where: { id: recipe.inventoryItemId }, data: { isActive: false } })
      }
      await tx.recipe.delete({ where: { id } })
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/recipes/:id]', err)
    return NextResponse.json({ error: 'Failed to delete recipe' }, { status: 500 })
  }
}
