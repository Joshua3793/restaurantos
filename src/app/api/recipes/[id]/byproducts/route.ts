import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { BYPRODUCT_COST_INCLUDE, fetchRecipeWithCost, resyncPrepRecipe, type ByproductCostRow } from '@/lib/recipeCosts'
import { assertKnownUnit, unitKind, UnitError } from '@/lib/uom'
import { getUnitConv } from '@/lib/utils'
import { dimensionOf, DIMENSION_BASE } from '@/lib/item-model'
import { requireSession, AuthError } from '@/lib/auth'
import { byproductError, creditGuard } from '@/lib/recipe-byproduct-guard'

export const dynamic = 'force-dynamic'

// POST /api/recipes/[id]/byproducts — add something else that comes off this
// PREP batch: an existing plain item, or a new one made on the spot
// (`createItem`, e.g. "Beef Bones" at $2.50/kg). Credited at the item's own
// price; refused when the credits would be more than the batch costs.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = (await req.json()) ?? {}
  const recipe = await prisma.recipe.findUnique({
    where: { id: params.id },
    select: { id: true, type: true, inventoryItemId: true, revenueCenterId: true },
  })
  if (!recipe) return byproductError('NOT_FOUND', 'Recipe not found', 404)
  if (recipe.type !== 'PREP') return byproductError('NOT_PREP', 'Only prep recipes have by-products.')

  const qty = Number(body.qty)
  if (!(qty > 0)) return byproductError('BAD_QTY', 'Enter how much comes off the batch.')
  let unit: string
  try { unit = assertKnownUnit(body.unit, 'by-product unit') }
  catch (e) { if (e instanceof UnitError) return byproductError('BAD_UNIT', e.message); throw e }

  const itemSelect = BYPRODUCT_COST_INCLUDE.include.inventoryItem.select
  const create = body.createItem as { itemName?: unknown; rate?: unknown } | undefined
  let previewItem: ByproductCostRow['inventoryItem']
  let newItem: Prisma.InventoryItemCreateInput | null = null

  if (create) {
    const itemName = typeof create.itemName === 'string' ? create.itemName.trim() : ''
    const rate = Number(create.rate)
    if (!itemName) return byproductError('BAD_NAME', 'Give the new item a name.')
    if (!(rate > 0)) return byproductError('BAD_PRICE', `What would you pay per ${unit}?`)
    if (unitKind(unit) !== 'measurement') return byproductError('BAD_UNIT', `Use a weight, volume or each for ${itemName}.`)
    const taken = await prisma.inventoryItem.findFirst({
      where: { itemName: { equals: itemName, mode: 'insensitive' }, isActive: true, mergedIntoId: null },
      select: { id: true, itemName: true },
    })
    if (taken) return byproductError('ITEM_EXISTS', `${taken.itemName} already exists — pick it from the list.`)

    const dimension = dimensionOf(unit)
    // Not counted (isStocked false) until by-products start entering stock —
    // otherwise cooks meet it on the count with an expected zero.
    newItem = {
      itemName,
      isStocked: false,
      dimension,
      baseUnit: DIMENSION_BASE[dimension],
      countUnit: unit,
      packChain: [{ unit, per: getUnitConv(unit) }],
      pricing: { mode: 'RATE', rate, rateUnit: unit },
    }
    previewItem = {
      itemName, lastUpdated: new Date(), dimension, baseUnit: DIMENSION_BASE[dimension], countUnit: unit,
      packChain: newItem.packChain as Prisma.JsonValue, pricing: newItem.pricing as Prisma.JsonValue,
      eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
      _count: { supplierPrices: 0 }, supplierPrices: [],
    }
  } else {
    const item = await prisma.inventoryItem.findUnique({
      where: { id: String(body.inventoryItemId ?? '') },
      select: { ...itemSelect, id: true, isActive: true, mergedIntoId: true, recipe: { select: { id: true } } },
    })
    if (!item) return byproductError('NOT_FOUND', 'Item not found', 404)
    if (item.id === recipe.inventoryItemId) return byproductError('OWN_OUTPUT', 'A recipe cannot come off itself.')
    if (item.recipe) return byproductError('PREP_OUTPUT', `${item.itemName} is made by a recipe — only plain items can come off a batch.`)
    if (!item.isActive || item.mergedIntoId) return byproductError('INACTIVE_ITEM', `${item.itemName} is switched off.`)
    const dup = await prisma.recipeByproduct.findFirst({ where: { recipeId: recipe.id, inventoryItemId: item.id }, select: { id: true } })
    if (dup) return byproductError('DUPLICATE', `${item.itemName} is already listed — change that row instead.`)
    previewItem = item
  }

  const itemId = create ? 'new' : String(body.inventoryItemId)
  const refused = await creditGuard(recipe.id, rows => [...rows, {
    id: 'new', recipeId: recipe.id, inventoryItemId: itemId, qty: new Prisma.Decimal(qty), unit,
    sortOrder: rows.length, notes: null, createdAt: new Date(), inventoryItem: previewItem,
  } as ByproductCostRow])
  if (refused) return refused

  const max = await prisma.recipeByproduct.aggregate({ where: { recipeId: recipe.id }, _max: { sortOrder: true } })
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null
  await prisma.$transaction(async tx => {
    let inventoryItemId = itemId
    if (newItem) {
      const made = await tx.inventoryItem.create({ data: newItem, select: { id: true } })
      inventoryItemId = made.id
      if (recipe.revenueCenterId) {
        await tx.itemRevenueCenter.create({ data: { inventoryItemId, revenueCenterId: recipe.revenueCenterId } })
      }
    }
    await tx.recipeByproduct.create({
      data: { recipeId: recipe.id, inventoryItemId, qty, unit, notes, sortOrder: (max._max.sortOrder ?? -1) + 1 },
    })
  })

  await resyncPrepRecipe(recipe.id).catch(e => console.error('[byproduct POST] resync', e))
  return NextResponse.json(await fetchRecipeWithCost(recipe.id, { basis: 'AVG_30D' }), { status: 201 })
}
