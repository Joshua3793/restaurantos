import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchRecipeWithCost, resyncPrepRecipe, propagatePrepCostChanges } from '@/lib/recipeCosts'
import { assertKnownUnit, UnitError } from '@/lib/uom'

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
  const { name, categoryId, baseYieldQty, yieldUnit, portionSize, portionUnit, menuPrice, notes, isActive, baseIngredientId, steps, revenueCenterId } = body

  // Validate + normalize units when they're being changed.
  let canonYield: string | undefined
  let canonPortion: string | null | undefined
  try {
    if (yieldUnit   !== undefined) canonYield   = assertKnownUnit(yieldUnit, 'yield unit')
    if (portionUnit !== undefined) canonPortion = portionUnit ? assertKnownUnit(portionUnit, 'portion unit') : null
  } catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }

  await prisma.recipe.update({
    where: { id: params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(baseYieldQty !== undefined ? { baseYieldQty: parseFloat(baseYieldQty) } : {}),
      ...(canonYield !== undefined ? { yieldUnit: canonYield } : {}),
      ...(portionSize !== undefined ? { portionSize: portionSize ? parseFloat(portionSize) : null } : {}),
      ...(canonPortion !== undefined ? { portionUnit: canonPortion } : {}),
      ...(menuPrice !== undefined ? { menuPrice: menuPrice ? parseFloat(menuPrice) : null } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(baseIngredientId !== undefined ? { baseIngredientId: baseIngredientId ?? null } : {}),
      ...(revenueCenterId !== undefined ? { revenueCenterId: revenueCenterId || null } : {}),
      ...(Array.isArray(steps) ? { steps: steps.filter((s: unknown) => typeof s === 'string') } : {}),
    },
  })

  // Re-sync the linked item (and dependents) when cost- or name-affecting fields change.
  // name flows to the PREPD item's itemName; yield qty/unit drive cost.
  const costAffecting = baseYieldQty !== undefined || yieldUnit !== undefined || name !== undefined
  if (costAffecting) await resyncPrepRecipe(params.id).catch(e => console.error('[recipe PATCH] resync', e))

  const updated = await fetchRecipeWithCost(params.id)
  return NextResponse.json(updated)
}

// Hard delete — cleans up references before removing the row
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id
  try {
    let deactivatedItemId: string | null = null
    await prisma.$transaction(async tx => {
      await tx.recipeIngredient.updateMany({ where: { linkedRecipeId: id }, data: { linkedRecipeId: null } })
      await tx.saleLineItem.deleteMany({ where: { recipeId: id } })
      await tx.prepItem.updateMany({ where: { linkedRecipeId: id }, data: { linkedRecipeId: null } })
      await tx.recipeAlert.deleteMany({ where: { recipeId: id } })
      const recipe = await tx.recipe.findUnique({ where: { id }, select: { inventoryItemId: true } })
      if (recipe?.inventoryItemId) {
        deactivatedItemId = recipe.inventoryItemId
        await tx.inventoryItem.update({ where: { id: recipe.inventoryItemId }, data: { isActive: false } })
      }
      await tx.recipe.delete({ where: { id } })
    })
    // A deleted PREP is no longer a priced ingredient — re-cost any prep that used it.
    if (deactivatedItemId) {
      await propagatePrepCostChanges([deactivatedItemId]).catch(e => console.error('[recipe DELETE] propagate', e))
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/recipes/:id]', err)
    return NextResponse.json({ error: 'Failed to delete recipe' }, { status: 500 })
  }
}
