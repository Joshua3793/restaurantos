import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computePriority, computeSuggestedQty, PREP_PRIORITY_ORDER } from '@/lib/prep-utils'
import { getTheoreticalStockMap } from '@/lib/count-expected'
import { convertQty, UnitError } from '@/lib/uom'
import { resolvePrepUnit } from '@/lib/prep-sync'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveScopedRcIds, assertRcWritable } from '@/lib/rc-scope'

const recipeInclude = {
  select: {
    id: true,
    name: true,
    yieldUnit: true,
    baseYieldQty: true,
    inventoryItemId: true,
    inventoryItem: {
      select: { id: true, stockOnHand: true, baseUnit: true },
    },
    ingredients: {
      include: {
        inventoryItem: {
          select: { id: true, itemName: true, stockOnHand: true },
        },
      },
    },
  },
} as const

export async function GET(req: NextRequest) {
  try {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const activeOnly = searchParams.get('active') !== 'false'

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 86_400_000)

  // Prep items have no rcId query param — scope to the user's RCs (always
  // including shared (null) prep). allowed===null (ADMIN / unscoped) → no filter,
  // so the list behaves exactly as before.
  const allowed = await resolveScopedRcIds(user)
  const scopeWhere = allowed === null
    ? {}
    : { OR: [{ revenueCenterId: null }, { revenueCenterId: { in: [...allowed] } }] }

  const items = await prisma.prepItem.findMany({
    where: { AND: [activeOnly ? { isActive: true } : {}, scopeWhere] },
    include: {
      linkedRecipe: recipeInclude,
      linkedInventoryItem: {
        select: { id: true, itemName: true, stockOnHand: true, baseUnit: true },
      },
      logs: {
        where: { logDate: { gte: today, lt: tomorrow } },
        take: 1,
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const prepItemIds = items.map(i => i.id)
  const doneLogs = await prisma.prepLog.findMany({
    where: { prepItemId: { in: prepItemIds }, status: { in: ['DONE', 'PARTIAL'] } },
    orderBy: { logDate: 'desc' },
    select: { prepItemId: true, logDate: true },
  })
  const lastMadeByItem = new Map<string, string>()
  for (const l of doneLogs) {
    if (!lastMadeByItem.has(l.prepItemId)) lastMadeByItem.set(l.prepItemId, l.logDate.toISOString())
  }

  // Build theoretical stock maps grouped by revenueCenterId (batched, not per-item).
  // Prep items span multiple RCs (including null = global/shared), so we group by RC,
  // fetch one map per distinct RC, then look each item up in its RC's map.
  // Mirrors the same pattern used in /api/prep/generate/route.ts.
  const rcToInvIds = new Map<string | null, string[]>()
  for (const item of items) {
    const invId = item.linkedInventoryItem?.id ?? item.linkedRecipe?.inventoryItem?.id
    if (!invId) continue
    const rc = item.revenueCenterId ?? null
    if (!rcToInvIds.has(rc)) rcToInvIds.set(rc, [])
    rcToInvIds.get(rc)!.push(invId)
  }
  const theoreticalMaps = new Map<string | null, Map<string, number>>()
  await Promise.all(
    Array.from(rcToInvIds.entries()).map(async ([rc, ids]) => {
      const map = await getTheoreticalStockMap(rc, ids)
      theoreticalMaps.set(rc, map)
    })
  )

  const enriched = items.map(item => {
    // Resolve onHand from theoretical stock (same engine as inventory list page)
    const invId = item.linkedInventoryItem?.id ?? item.linkedRecipe?.inventoryItem?.id
    const rc = item.revenueCenterId ?? null
    let onHand = 0
    if (invId) {
      const theoreticalQty = theoreticalMaps.get(rc)?.get(invId)
      if (theoreticalQty !== undefined) {
        onHand = theoreticalQty
      } else if (item.linkedInventoryItem) {
        onHand = parseFloat(String(item.linkedInventoryItem.stockOnHand))
      } else if (item.linkedRecipe?.inventoryItem) {
        onHand = parseFloat(String(item.linkedRecipe.inventoryItem.stockOnHand))
      }
    }

    // onHand resolves in the inventory item's baseUnit (g/ml/each), but parLevel,
    // minThreshold and targetToday are stored in the prep item's display unit
    // (e.g. l, kg). Convert onHand into the prep unit so every downstream calc
    // (priority, suggestedQty, the % badge, the displayed on-hand) is unit-consistent.
    // convertQty passes through unchanged when units already match or share no dimension.
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

    // Blocked check — any ingredient at zero stock?
    // The recipe ingredients are already resolved (with stockOnHand) via recipeInclude.
    let isBlocked   = false
    let blockedReason: string | null = null
    let ingredientTotalCount: number | null = null
    let ingredientShortCount: number | null = null
    if (item.linkedRecipe) {
      const ings = item.linkedRecipe.ingredients
      ingredientTotalCount = ings.length
      ingredientShortCount = ings.filter(
        ing => ing.inventoryItem != null && Number(ing.inventoryItem.stockOnHand) <= 0,
      ).length
      const low = ings
        .filter(ing => ing.inventoryItem && parseFloat(String(ing.inventoryItem.stockOnHand)) <= 0)
        .map(ing => ing.inventoryItem!.itemName)
      if (low.length > 0) {
        isBlocked     = true
        blockedReason = `Low stock: ${low.join(', ')}`
      }
    }

    return {
      id: item.id,
      name: item.name,
      category: item.category,
      station: item.station,
      parLevel,
      unit: item.unit,
      minThreshold,
      targetToday,
      shelfLifeDays: item.shelfLifeDays,
      estimatedPrepTime: item.estimatedPrepTime ?? null,
      notes: item.notes,
      manualPriorityOverride: item.manualPriorityOverride,
      isActive: item.isActive,
      isOnList: item.isOnList,
      linkedRecipeId: item.linkedRecipeId,
      linkedRecipe: item.linkedRecipe
        ? {
            id: item.linkedRecipe.id,
            name: item.linkedRecipe.name,
            yieldUnit: item.linkedRecipe.yieldUnit,
            baseYieldQty: parseFloat(String(item.linkedRecipe.baseYieldQty)),
          }
        : null,
      linkedInventoryItemId: item.linkedInventoryItemId,
      onHand,
      priority,
      suggestedQty,
      isBlocked,
      blockedReason,
      ingredientTotalCount,
      ingredientShortCount,
      lastMadeAt: lastMadeByItem.get(item.id) ?? null,
      revenueCenterId: item.revenueCenterId ?? null,
      todayLog: item.logs[0] ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }
  })

  enriched.sort((a, b) => {
    const pa = PREP_PRIORITY_ORDER.indexOf(a.priority)
    const pb = PREP_PRIORITY_ORDER.indexOf(b.priority)
    if (pa !== pb) return pa - pb
    return a.name.localeCompare(b.name)
  })

  // This list is mutated constantly (add to list, status, priority) and the client
  // updates optimistically then refetches. A cached/SWR response makes load() return
  // the pre-mutation snapshot, reverting optimistic adds — so never cache it.
  return NextResponse.json(enriched, {
    headers: { 'Cache-Control': 'no-store' },
  })
  } catch (err) {
    console.error('[prep/items GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const {
    name, linkedRecipeId, linkedInventoryItemId,
    category, station, parLevel, unit, minThreshold,
    targetToday, shelfLifeDays, estimatedPrepTime, notes, manualPriorityOverride,
    revenueCenterId,
  } = body

  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  // Prep items may be Shared (revenueCenterId null) — only guard when one is set.
  if (revenueCenterId) {
    try { await assertRcWritable(user, revenueCenterId) }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  let resolvedUnit: string
  try {
    resolvedUnit = await resolvePrepUnit(linkedRecipeId || null, unit)
  } catch (err) {
    if (err instanceof UnitError) return NextResponse.json({ error: err.message }, { status: 400 })
    throw err
  }

  const item = await prisma.prepItem.create({
    data: {
      name,
      linkedRecipeId:        linkedRecipeId        || null,
      linkedInventoryItemId: linkedInventoryItemId || null,
      category:              category              || 'MISC',
      station:               station               || null,
      parLevel:              parLevel   ? parseFloat(String(parLevel))   : 0,
      unit:                  resolvedUnit,
      minThreshold:          minThreshold ? parseFloat(String(minThreshold)) : 0,
      targetToday:           targetToday  ? parseFloat(String(targetToday))  : null,
      shelfLifeDays:         shelfLifeDays ? parseInt(String(shelfLifeDays)) : null,
      estimatedPrepTime:     estimatedPrepTime ? parseInt(String(estimatedPrepTime)) : null,
      notes:                 notes || null,
      manualPriorityOverride: manualPriorityOverride || null,
      revenueCenterId:        revenueCenterId        || null,
    },
  })

  return NextResponse.json(item, { status: 201 })
}
