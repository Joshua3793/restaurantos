import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computePriority, computeSuggestedQty } from '@/lib/prep-utils'

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
                  baseUnit: true, pricePerBaseUnit: true,
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

  let onHand = 0
  if (item.linkedInventoryItem) {
    onHand = parseFloat(String(item.linkedInventoryItem.stockOnHand))
  } else if (item.linkedRecipe?.inventoryItem) {
    onHand = parseFloat(String(item.linkedRecipe.inventoryItem.stockOnHand))
  }

  const parLevel     = parseFloat(String(item.parLevel))
  const minThreshold = parseFloat(String(item.minThreshold))
  const targetToday  = item.targetToday ? parseFloat(String(item.targetToday)) : null
  const priority     = computePriority(onHand, parLevel, minThreshold, targetToday, item.manualPriorityOverride)
  const suggestedQty = computeSuggestedQty(onHand, parLevel, targetToday)

  const ingredients = (item.linkedRecipe?.ingredients ?? []).map(ing => ({
    id: ing.id,
    inventoryItemId: ing.inventoryItemId,
    itemName: ing.inventoryItem?.itemName ?? 'Sub-recipe',
    qtyBase: parseFloat(String(ing.qtyBase)),
    unit: ing.unit,
    stockOnHand: ing.inventoryItem ? parseFloat(String(ing.inventoryItem.stockOnHand)) : null,
    isAvailable: ing.inventoryItem ? parseFloat(String(ing.inventoryItem.stockOnHand)) > 0 : null,
  }))

  const lowIngredients = ingredients.filter(i => i.isAvailable === false).map(i => i.itemName)

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
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = await req.json()

  const item = await prisma.prepItem.update({
    where: { id: params.id },
    data: {
      ...(body.name                   !== undefined && { name: body.name }),
      ...(body.linkedRecipeId         !== undefined && { linkedRecipeId: body.linkedRecipeId || null }),
      ...(body.linkedInventoryItemId  !== undefined && { linkedInventoryItemId: body.linkedInventoryItemId || null }),
      ...(body.category               !== undefined && { category: body.category }),
      ...(body.station                !== undefined && { station: body.station || null }),
      ...(body.parLevel               !== undefined && { parLevel: parseFloat(String(body.parLevel)) }),
      ...(body.unit                   !== undefined && { unit: body.unit }),
      ...(body.minThreshold           !== undefined && { minThreshold: parseFloat(String(body.minThreshold)) }),
      ...(body.targetToday            !== undefined && { targetToday: body.targetToday ? parseFloat(String(body.targetToday)) : null }),
      ...(body.shelfLifeDays          !== undefined && { shelfLifeDays: body.shelfLifeDays ? parseInt(String(body.shelfLifeDays)) : null }),
      ...(body.notes                  !== undefined && { notes: body.notes || null }),
      ...(body.manualPriorityOverride !== undefined && { manualPriorityOverride: body.manualPriorityOverride || null }),
      ...(body.isActive               !== undefined && { isActive: body.isActive }),
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
