import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchRecipeWithCost, syncPrepToInventory } from '@/lib/recipeCosts'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const recipe = await fetchRecipeWithCost(params.id)
  if (!recipe) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(recipe)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { name, categoryId, baseYieldQty, yieldUnit, portionSize, portionUnit, menuPrice, notes, isActive } = body

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
    },
  })

  await syncPrepToInventory(params.id)
  const updated = await fetchRecipeWithCost(params.id)
  return NextResponse.json(updated)
}

// Hard delete — cleans up references before removing the row
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id
  try {
    await prisma.$transaction(async tx => {
      // 1. Null out any ingredients in other recipes that link to this recipe
      await tx.recipeIngredient.updateMany({ where: { linkedRecipeId: id }, data: { linkedRecipeId: null } })
      // 2. Remove sale line items referencing this recipe
      await tx.saleLineItem.deleteMany({ where: { recipeId: id } })
      // 3. Disconnect prep items that reference this recipe
      await tx.prepItem.updateMany({ where: { linkedRecipeId: id }, data: { linkedRecipeId: null } })
      // 4. Remove recipe alerts for this recipe
      await tx.recipeAlert.deleteMany({ where: { recipeId: id } })
      // 5. For PREP recipes: deactivate the synced inventory item (don't hard-delete — it may have stock history)
      const recipe = await tx.recipe.findUnique({ where: { id }, select: { inventoryItemId: true } })
      if (recipe?.inventoryItemId) {
        await tx.inventoryItem.update({ where: { id: recipe.inventoryItemId }, data: { isActive: false } })
      }
      // 6. Delete the recipe — cascades to its own RecipeIngredient rows
      await tx.recipe.delete({ where: { id } })
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/recipes/:id]', err)
    return NextResponse.json({ error: 'Failed to delete recipe' }, { status: 500 })
  }
}
