import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resyncPrepRecipe } from '@/lib/recipeCosts'
import { assertKnownUnit, UnitError } from '@/lib/uom'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; ingredientId: string } }
) {
  const body = await req.json()
  const { qtyBase, unit, notes, sortOrder, recipePercent, inventoryItemId, linkedRecipeId } = body

  // Validate + normalize the unit when it's being changed.
  let canonUnit: string | undefined
  if (unit !== undefined) {
    try { canonUnit = assertKnownUnit(unit, 'ingredient unit') }
    catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }
  }

  await prisma.recipeIngredient.update({
    where: { id: params.ingredientId },
    data: {
      ...(qtyBase !== undefined ? { qtyBase: parseFloat(qtyBase) } : {}),
      ...(canonUnit !== undefined ? { unit: canonUnit } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      ...(recipePercent !== undefined ? { recipePercent: recipePercent !== null ? parseFloat(recipePercent) : null } : {}),
      // Substituting with an inventory item — clears linkedRecipeId
      ...(inventoryItemId !== undefined && linkedRecipeId === undefined ? { inventoryItemId, linkedRecipeId: null } : {}),
      // Substituting with a linked recipe — clears inventoryItemId
      ...(linkedRecipeId !== undefined ? { linkedRecipeId, inventoryItemId: null } : {}),
    },
  })

  // Re-sync the linked item and dependent preps. Awaited so the cascade runs before
  // responding; caught so a rare sync hiccup doesn't fail the edit (headless endpoint repairs).
  const costAffecting = qtyBase !== undefined || unit !== undefined || inventoryItemId !== undefined || linkedRecipeId !== undefined
  if (costAffecting) await resyncPrepRecipe(params.id).catch(e => console.error('[ingredient PATCH] resync', e))

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; ingredientId: string } }
) {
  await prisma.recipeIngredient.delete({ where: { id: params.ingredientId } })

  await resyncPrepRecipe(params.id).catch(e => console.error('[ingredient DELETE] resync', e))

  return NextResponse.json({ ok: true })
}
