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
  const { qtyBase, unit, notes, sortOrder, recipePercent, inventoryItemId, linkedRecipeId, customName } = body

  // Load the existing row to know whether it's a custom line (free-form unit) and
  // whether this PATCH is promoting it to a costed line.
  const existing = await prisma.recipeIngredient.findUnique({
    where: { id: params.ingredientId },
    select: { customName: true },
  })
  if (!existing) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

  const promoting = inventoryItemId !== undefined || linkedRecipeId !== undefined
  const isCustomAfter = !promoting && existing.customName !== null

  // Validate the unit only for costed lines. Custom lines store the unit raw.
  let unitToStore: string | undefined
  if (unit !== undefined) {
    if (isCustomAfter) {
      unitToStore = unit
    } else {
      try { unitToStore = assertKnownUnit(unit, 'ingredient unit') }
      catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }
    }
  }

  await prisma.recipeIngredient.update({
    where: { id: params.ingredientId },
    data: {
      ...(qtyBase !== undefined ? { qtyBase: parseFloat(qtyBase) } : {}),
      ...(unitToStore !== undefined ? { unit: unitToStore } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      ...(recipePercent !== undefined ? { recipePercent: recipePercent !== null ? parseFloat(recipePercent) : null } : {}),
      ...(customName !== undefined ? { customName: customName || null } : {}),
      // Substituting with an inventory item — clears linkedRecipeId and any customName.
      ...(inventoryItemId !== undefined && linkedRecipeId === undefined ? { inventoryItemId, linkedRecipeId: null, customName: null } : {}),
      // Substituting with a linked recipe — clears inventoryItemId and any customName.
      ...(linkedRecipeId !== undefined ? { linkedRecipeId, inventoryItemId: null, customName: null } : {}),
    },
  })

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
