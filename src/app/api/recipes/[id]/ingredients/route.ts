import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resyncPrepRecipe } from '@/lib/recipeCosts'
import { assertKnownUnit, UnitError } from '@/lib/uom'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { inventoryItemId, linkedRecipeId, qtyBase, unit, notes, recipePercent } = body

  // Exactly one of inventoryItemId / linkedRecipeId must be set
  const hasInv = !!inventoryItemId
  const hasLinked = !!linkedRecipeId
  if (hasInv === hasLinked) {
    return NextResponse.json(
      { error: 'Provide exactly one of inventoryItemId or linkedRecipeId' },
      { status: 400 }
    )
  }

  // Validate + normalize the ingredient unit against the UOM backbone.
  let canonUnit: string
  try { canonUnit = assertKnownUnit(unit, 'ingredient unit') }
  catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }

  const maxOrder = await prisma.recipeIngredient.aggregate({
    where: { recipeId: params.id },
    _max: { sortOrder: true },
  })
  const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1

  const ing = await prisma.recipeIngredient.create({
    data: {
      recipeId: params.id,
      inventoryItemId: inventoryItemId || null,
      linkedRecipeId: linkedRecipeId || null,
      qtyBase: parseFloat(qtyBase),
      unit: canonUnit,
      sortOrder,
      notes: notes || null,
      recipePercent: recipePercent !== undefined && recipePercent !== null ? parseFloat(recipePercent) : null,
    },
    include: {
      inventoryItem: { select: { itemName: true } },
      linkedRecipe: { select: { name: true, yieldUnit: true } },
    },
  })

  // Keep the linked inventory item and dependent preps in sync. Awaited so the cascade
  // runs before responding; caught so a rare sync hiccup doesn't fail the edit (the
  // headless /api/inventory/sync-prepd endpoint is the recovery path).
  await resyncPrepRecipe(params.id).catch(e => console.error('[ingredient POST] resync', e))
  return NextResponse.json({ id: ing.id }, { status: 201 })
}
