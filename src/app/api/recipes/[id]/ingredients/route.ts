import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepToInventory } from '@/lib/recipeCosts'
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
      inventoryItem: { select: { itemName: true, pricePerBaseUnit: true } },
      linkedRecipe: { select: { name: true, yieldUnit: true } },
    },
  })

  // Fire sync in background — client handles optimistic display
  syncPrepToInventory(params.id).catch(console.error)
  return NextResponse.json({ id: ing.id }, { status: 201 })
}
