import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { computePriority, computeSuggestedQty, numOrNull } from '@/lib/prep-utils'
import { convertQty, UnitError } from '@/lib/uom'
import { resolvePrepUnit } from '@/lib/prep-sync'
import { PRICING_SELECT } from '@/lib/item-model'
import { numOrNull } from '@/lib/prep-utils'

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

  // Mirrors the RC guard that POST /api/prep/items already performs. Without it a
  // scoped user could edit an item belonging to an RC they cannot write — and, by
  // sending revenueCenterId, move an item INTO or OUT OF one. Both the current
  // owner and the target are checked; a Shared item (null RC) has no owner to check.
  try {
    const current = await prisma.prepItem.findUnique({
      where: { id: params.id },
      select: { revenueCenterId: true },
    })
    if (current?.revenueCenterId) await assertRcWritable(user, current.revenueCenterId)
    if (body.revenueCenterId) await assertRcWritable(user, body.revenueCenterId)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

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
      // Run-sheet timing + target service. These are the inputs `startByMinutes`
      // counts back from (service − hands-on − passive); without them a row has no
      // place on the time ladder. Empty string ⇒ null so "clear the field" works —
      // for the minutes that means "fall back to the linked recipe", and for the
      // service it means "no service, no start-by".
      ...(body.targetServiceId        !== undefined && { targetServiceId: body.targetServiceId || null }),
      ...(body.activeMinutesOverride  !== undefined && { activeMinutesOverride: numOrNull(body.activeMinutesOverride) }),
      ...(body.passiveMinutesOverride !== undefined && { passiveMinutesOverride: numOrNull(body.passiveMinutesOverride) }),
      ...(body.passiveNoteOverride    !== undefined && { passiveNoteOverride: body.passiveNoteOverride || null }),
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
