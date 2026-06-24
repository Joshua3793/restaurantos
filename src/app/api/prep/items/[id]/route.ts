import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computePriority, computeSuggestedQty } from '@/lib/prep-utils'
import { getTheoreticalStock } from '@/lib/count-expected'
import { convertQty, UnitError } from '@/lib/uom'
import { resolvePrepUnit } from '@/lib/prep-sync'
import { PRICING_SELECT } from '@/lib/item-model'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const item = await prisma.prepItem.findUnique({
    where: { id: params.id },
    include: {
      linkedRecipe: {
        include: {
          inventoryItem: {
            select: { id: true, itemName: true, stockOnHand: true, baseUnit: true },
          },
          ingredients: {
            include: {
              inventoryItem: {
                select: {
                  id: true, itemName: true, stockOnHand: true,
                  ...PRICING_SELECT,
                },
              },
              // Sub-recipe ingredients (e.g. Custard inside French Toast) carry a
              // linkedRecipe instead of an inventoryItem — pull its name + the
              // stock of its synced inventory item for availability.
              linkedRecipe: {
                select: {
                  id: true, name: true,
                  inventoryItem: { select: { stockOnHand: true } },
                },
              },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
      linkedInventoryItem: true,
      logs: { orderBy: { logDate: 'desc' }, take: 30 },
    },
  })

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const linkedInvId = item.linkedInventoryItem?.id ?? item.linkedRecipe?.inventoryItem?.id
  let onHand = 0
  if (linkedInvId) {
    const theoretical = await getTheoreticalStock(linkedInvId, item.revenueCenterId)
    if (theoretical != null) {
      onHand = theoretical
    } else if (item.linkedInventoryItem) {
      onHand = parseFloat(String(item.linkedInventoryItem.stockOnHand))
    } else if (item.linkedRecipe?.inventoryItem) {
      onHand = parseFloat(String(item.linkedRecipe.inventoryItem.stockOnHand))
    }
  }

  // theoretical onHand is in baseUnit (g/ml/each); par/min/target are in the prep
  // item's display unit — convert so comparisons and the suggested qty are consistent.
  const invBaseUnit =
    item.linkedInventoryItem?.baseUnit ?? item.linkedRecipe?.inventoryItem?.baseUnit ?? null
  if (invBaseUnit && item.unit) {
    onHand = convertQty(onHand, invBaseUnit, item.unit)
  }

  const parLevel     = parseFloat(String(item.parLevel))
  const minThreshold = parseFloat(String(item.minThreshold))
  const targetToday  = item.targetToday ? parseFloat(String(item.targetToday)) : null
  const priority     = computePriority(onHand, parLevel, minThreshold, targetToday, item.manualPriorityOverride)
  const suggestedQty = computeSuggestedQty(onHand, parLevel, targetToday)

  const ingredients = (item.linkedRecipe?.ingredients ?? []).map(ing => {
    const subStock = ing.linkedRecipe?.inventoryItem?.stockOnHand
    const stock = ing.inventoryItem
      ? parseFloat(String(ing.inventoryItem.stockOnHand))
      : subStock != null
        ? parseFloat(String(subStock))
        : null
    return {
      id: ing.id,
      inventoryItemId: ing.inventoryItemId,
      linkedRecipeId: ing.linkedRecipe?.id ?? ing.linkedRecipeId ?? null,
      itemName: ing.inventoryItem?.itemName ?? ing.linkedRecipe?.name ?? 'Sub-recipe',
      qtyBase: parseFloat(String(ing.qtyBase)),
      unit: ing.unit,
      stockOnHand: stock,
      isAvailable: stock != null ? stock > 0 : null,
    }
  })

  const lowIngredients = ingredients.filter(i => i.isAvailable === false).map(i => i.itemName)

  const lastMadeLog = await prisma.prepLog.findFirst({
    where: { prepItemId: params.id, status: { in: ['DONE', 'PARTIAL'] } },
    orderBy: { logDate: 'desc' },
    select: { logDate: true },
  })

  return NextResponse.json({
    ...item,
    parLevel,
    minThreshold,
    targetToday,
    onHand,
    priority,
    suggestedQty,
    ingredients,
    isBlocked: lowIngredients.length > 0,
    blockedReason: lowIngredients.length > 0 ? `Low stock: ${lowIngredients.join(', ')}` : null,
    ingredientTotalCount: ingredients.length,
    ingredientShortCount: ingredients.filter(
      g => g.stockOnHand != null && Number(g.stockOnHand) <= 0,
    ).length,
    lastMadeAt: lastMadeLog ? lastMadeLog.logDate.toISOString() : null,
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = await req.json()

  // Resolve the unit defensively: a recipe-linked item inherits the recipe's yield
  // unit; a free-standing item's unit must be a known canonical token. This closes
  // the dimension-mismatch hole regardless of what the client sends.
  let unitToWrite: string | undefined
  if (body.unit !== undefined || body.linkedRecipeId !== undefined) {
    const effectiveRecipeId =
      body.linkedRecipeId !== undefined
        ? (body.linkedRecipeId || null)
        : (await prisma.prepItem.findUnique({
            where: { id: params.id },
            select: { linkedRecipeId: true },
          }))?.linkedRecipeId ?? null
    // Only recompute the unit when the caller touched it or re-linked a recipe.
    if (body.unit !== undefined || effectiveRecipeId) {
      try {
        unitToWrite = await resolvePrepUnit(effectiveRecipeId, body.unit)
      } catch (err) {
        if (err instanceof UnitError) return NextResponse.json({ error: err.message }, { status: 400 })
        throw err
      }
    }
  }

  const item = await prisma.prepItem.update({
    where: { id: params.id },
    data: {
      ...(body.name                   !== undefined && { name: body.name }),
      ...(body.linkedRecipeId         !== undefined && { linkedRecipeId: body.linkedRecipeId || null }),
      ...(body.linkedInventoryItemId  !== undefined && { linkedInventoryItemId: body.linkedInventoryItemId || null }),
      ...(body.category               !== undefined && { category: body.category }),
      ...(body.station                !== undefined && { station: body.station || null }),
      ...(body.parLevel               !== undefined && { parLevel: parseFloat(String(body.parLevel)) }),
      ...(unitToWrite                 !== undefined && { unit: unitToWrite }),
      ...(body.minThreshold           !== undefined && { minThreshold: parseFloat(String(body.minThreshold)) }),
      ...(body.targetToday            !== undefined && { targetToday: body.targetToday ? parseFloat(String(body.targetToday)) : null }),
      ...(body.shelfLifeDays          !== undefined && { shelfLifeDays: body.shelfLifeDays ? parseInt(String(body.shelfLifeDays)) : null }),
      ...(body.estimatedPrepTime      !== undefined && { estimatedPrepTime: body.estimatedPrepTime ? parseInt(String(body.estimatedPrepTime)) : null }),
      ...(body.notes                  !== undefined && { notes: body.notes || null }),
      ...(body.manualPriorityOverride !== undefined && { manualPriorityOverride: body.manualPriorityOverride || null }),
      ...(body.revenueCenterId        !== undefined && { revenueCenterId: body.revenueCenterId || null }),
      ...(body.isActive               !== undefined && { isActive: body.isActive }),
      ...(body.isOnList               !== undefined && { isOnList: body.isOnList }),
    },
  })

  return NextResponse.json(item)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  await prisma.prepItem.update({
    where: { id: params.id },
    data: { isActive: false },
  })
  return NextResponse.json({ ok: true })
}
