import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { computePriority, computeSuggestedQty } from '@/lib/prep-utils'
import { convertQty } from '@/lib/uom'
import { PRICING_SELECT } from '@/lib/item-model'
import { markPlanDirty } from '@/lib/prep-plan-server'
import { stationLabel } from '@/lib/prep-plan'

// Mutating handlers must never be statically prerendered — a prerendered
// route serves GET only and returns 405 for everything else.
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

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

  // NOTE: this onHand is the cheap raw stock, NOT the authoritative theoretical value.
  // The client already holds the theoretical onHand from the list (/api/prep/items) and
  // the drawer displays *that* — this detail route only supplies ingredients / steps /
  // last-made. It used to call getTheoreticalStock here, which re-scanned the entire
  // movement history for a single item and made every drawer/recipe open take ~3-4s.
  const linkedInvId = item.linkedInventoryItem?.id ?? item.linkedRecipe?.inventoryItem?.id
  let onHand = 0
  if (linkedInvId) {
    if (item.linkedInventoryItem) {
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
      // Same precedence as computeRecipeCost: inventory item → sub-recipe → custom
      // (uncosted) free-text name. Without the customName arm every custom ingredient
      // rendered as the literal "Sub-recipe" in the prep drawer.
      itemName: ing.inventoryItem?.itemName ?? ing.linkedRecipe?.name ?? ing.customName ?? 'Ingredient',
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
    station: stationLabel(item),
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
  // Authenticate BEFORE touching the body: an unauthenticated caller should not be
  // able to make the server parse arbitrary input.
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  // A malformed body is a client error, not a server fault — `await req.json()`
  // on its own throws a SyntaxError that surfaces as an opaque 500.
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // The prep item's identity and line settings (name, unit, category, par, shelf
  // life, stations, revenue center) are written by the RECIPE — recipe sync and
  // PATCH /api/recipes/[id] { prep }. This route owns only the planner state.
  // Planner fields are the chef's: draft membership + priority override = LEAD+.
  // Cooks still start/finish/claim (those flow through the prep-logs routes).
  if (body.isOnList !== undefined || body.manualPriorityOverride !== undefined) {
    try { await requireSession('LEAD') }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  // A scoped user may only touch items in an RC they can write; a Shared item
  // (null RC) has no owner to check.
  try {
    const current = await prisma.prepItem.findUnique({
      where: { id: params.id },
      select: { revenueCenterId: true },
    })
    if (current?.revenueCenterId) await assertRcWritable(user, current.revenueCenterId)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const item = await prisma.prepItem.update({
    where: { id: params.id },
    data: {
      ...(body.manualPriorityOverride !== undefined && { manualPriorityOverride: body.manualPriorityOverride || null }),
      ...(body.isActive               !== undefined && { isActive: body.isActive }),
      ...(body.isOnList               !== undefined && { isOnList: body.isOnList }),
    },
  })

  // A draft-membership or priority change after posting leaves the kitchen on a
  // stale list — flag today's post so both surfaces show "unposted changes".
  if (body.isOnList !== undefined || body.manualPriorityOverride !== undefined) {
    await markPlanDirty(item.revenueCenterId)
  }

  return NextResponse.json(item)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  await prisma.prepItem.update({
    where: { id: params.id },
    data: { isActive: false },
  })
  return NextResponse.json({ ok: true })
}
