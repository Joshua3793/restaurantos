import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resyncPrepRecipe } from '@/lib/recipeCosts'
import { assertKnownUnit, UnitError } from '@/lib/uom'
import { requireSession, AuthError } from '@/lib/auth'
import { parseAllergenKeys } from '@/lib/allergens'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const { inventoryItemId, linkedRecipeId, qtyBase, unit, notes, recipePercent, customName, allergens } = body

  const hasInv = !!inventoryItemId
  const hasLinked = !!linkedRecipeId
  const hasCustom = typeof customName === 'string' && customName.trim().length > 0

  // Exactly one kind: inventory, linked recipe, or custom.
  const kinds = [hasInv, hasLinked, hasCustom].filter(Boolean).length
  if (kinds !== 1) {
    return NextResponse.json(
      { error: 'Provide exactly one of inventoryItemId, linkedRecipeId, or customName' },
      { status: 400 }
    )
  }

  // Hand-tagged allergens: custom lines only (a linked line inherits its item's),
  // and only MANAGER+ may write them. Every other field needs only a session.
  let allergenKeys: string[] = []
  if (allergens !== undefined) {
    try { await requireSession('MANAGER') }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
    if (!hasCustom) {
      return NextResponse.json({ error: 'allergens can only be set on a custom line' }, { status: 400 })
    }
    const parsed = parseAllergenKeys(allergens)
    if (!parsed) return NextResponse.json({ error: 'allergens must be an array of known allergen names' }, { status: 400 })
    allergenKeys = parsed
  }

  // Custom lines carry a free-form unit and are never costed → skip UOM validation.
  // Inventory/recipe lines must resolve to a known unit.
  let storedUnit: string
  if (hasCustom) {
    storedUnit = typeof unit === 'string' ? unit : ''
  } else {
    try { storedUnit = assertKnownUnit(unit, 'ingredient unit') }
    catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }
  }

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
      customName: hasCustom ? customName.trim() : null,
      allergens: allergenKeys,
      qtyBase: qtyBase !== undefined && qtyBase !== null && qtyBase !== '' ? parseFloat(qtyBase) : 0,
      unit: storedUnit,
      sortOrder,
      notes: notes || null,
      recipePercent: recipePercent !== undefined && recipePercent !== null ? parseFloat(recipePercent) : null,
    },
    include: {
      inventoryItem: { select: { itemName: true } },
      linkedRecipe: { select: { name: true, yieldUnit: true } },
    },
  })

  await resyncPrepRecipe(params.id).catch(e => console.error('[ingredient POST] resync', e))
  return NextResponse.json({ id: ing.id }, { status: 201 })
}
