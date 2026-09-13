import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { urgencyToPriority, PREP_PRIORITY_ORDER } from '@/lib/prep-utils'
import { getTheoreticalStockMapCached } from '@/lib/theoretical-cache'
import { convertQty } from '@/lib/uom'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveScopedRcIds, resolveLocationRcIds } from '@/lib/rc-scope'
import { resolveActive, resolvePassive, resolvePassiveNote } from '@/lib/prep-runsheet'
import { prepDayRange, prepDaysAgo } from '@/lib/prep-day'
import { NEWEST_LOG } from '@/lib/prep-plan-server'
import { isLiveLog, pipelineOf, effectiveUrgency, cappedSuggestedQty, stationLabel } from '@/lib/prep-plan'
import { resolveStages } from '@/lib/prep-stages'
import { cadenceStats, CADENCE_WINDOW_DAYS } from '@/lib/prep-cadence'

// GET reads req.url so it is dynamic by usage; declare it so a refactor can never prerender it.
export const dynamic = 'force-dynamic'

const recipeInclude = {
  select: {
    id: true,
    name: true,
    yieldUnit: true,
    baseYieldQty: true,
    inventoryItemId: true,
    activeMinutes: true,
    passiveMinutes: true,
    passiveNote: true,
    stages: true,
    method: true,
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
  // Items switched off the prep list (prepEnabled=false) stay out of every
  // consumer's view — Pass, Pre-shift, Today, the run sheet — unless the caller
  // asks for them (the prep page does, to offer the switch back on).
  const includeHidden = searchParams.get('includeHidden') === 'true'

  // Restaurant-local day (see src/lib/prep-day.ts) — NOT server wall-clock, which
  // on Vercel is UTC and would swap in tomorrow's log at 5pm Pacific, mid-service.
  const { gte: today } = prepDayRange()

  // Scope to the active RC (or a location's child RCs) when passed — matching the
  // /prep page and the RC-scoped Pass cards — else fall back to all the user's RCs.
  // Shared (revenueCenterId null) prep ALWAYS shows: it belongs to every RC.
  // allowed===null (ADMIN / unscoped) with no rc/location param → no filter.
  const rcId = searchParams.get('rcId')
  const locationId = searchParams.get('locationId')
  const allowed = await resolveScopedRcIds(user)
  let rcIn: string[] | null // null = no concrete-RC restriction (shared prep still shows)
  if (locationId) {
    rcIn = await resolveLocationRcIds(user, locationId)
  } else if (rcId) {
    // Honor an rcId only inside the caller's scope; out-of-scope → shared prep only.
    rcIn = allowed === null || allowed.has(rcId) ? [rcId] : []
  } else {
    rcIn = allowed === null ? null : [...allowed]
  }
  const scopeWhere = rcIn === null
    ? {}
    : { OR: [{ revenueCenterId: null }, { revenueCenterId: { in: rcIn } }] }

  const items = await prisma.prepItem.findMany({
    where: { AND: [activeOnly ? { isActive: true } : {}, includeHidden ? {} : { prepEnabled: true }, scopeWhere] },
    include: {
      linkedRecipe: recipeInclude,
      linkedInventoryItem: {
        select: { id: true, itemName: true, stockOnHand: true, baseUnit: true },
      },
      // The item's NEWEST log — `isLiveLog` below decides whether it still counts
      // as the item's live job. Not "today's log": the kitchen posts the next
      // day's list at the end of a shift and unfinished jobs carry forward until
      // they are done or taken off.
      logs: NEWEST_LOG,
    },
    orderBy: { createdAt: 'asc' },
  })

  // Only identity fields reach `assignedCook` below (id, initials, name,
  // homeStation) — select narrowly rather than pulling Cook's tip-payroll
  // columns (wage, clockId, ...) into memory just to discard them. Mirrors
  // the select in GET /api/prep/cooks.
  const cooks = await prisma.cook.findMany({
    where: { isActive: true },
    select: { id: true, initials: true, name: true, homeStation: true },
  })
  const cookById = new Map(cooks.map(c => [c.id, c]))

  // Last-made per item = one aggregate row each (max logDate), not every historical
  // DONE/PARTIAL log. The old findMany pulled the entire done-log history for all items.
  const prepItemIds = items.map(i => i.id)
  const doneAgg = await prisma.prepLog.groupBy({
    by: ['prepItemId'],
    where: { prepItemId: { in: prepItemIds }, status: { in: ['DONE', 'PARTIAL'] } },
    _max: { logDate: true },
  })
  const lastMadeByItem = new Map<string, string>()
  for (const g of doneAgg) {
    if (g._max.logDate) lastMadeByItem.set(g.prepItemId, g._max.logDate.toISOString())
  }

  // Cadence (prep-cadence.ts): the completed logs of the last 60 days, one
  // narrow scan for every item — interval between makes, typical batch, and a
  // usage proxy. `lastMadeAt` above stays as the all-time value.
  const now = new Date()
  const recentDone = await prisma.prepLog.findMany({
    where: {
      prepItemId: { in: prepItemIds },
      status: { in: ['DONE', 'PARTIAL'] },
      logDate: { gte: prepDaysAgo(CADENCE_WINDOW_DAYS, now) },
      actualPrepQty: { gt: 0 },
    },
    select: { prepItemId: true, logDate: true, actualPrepQty: true },
  })
  const recentByItem = new Map<string, Array<{ logDate: Date; actualPrepQty: number }>>()
  for (const r of recentDone) {
    if (!recentByItem.has(r.prepItemId)) recentByItem.set(r.prepItemId, [])
    recentByItem.get(r.prepItemId)!.push({ logDate: r.logDate, actualPrepQty: Number(r.actualPrepQty) })
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
      const map = await getTheoreticalStockMapCached(rc, ids)
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

    // Step + suggestion through the same helpers the planner uses client-side,
    // so the cadence nudge (TMRW → CLOSE when due by rhythm) and the shelf-life
    // cap agree on both ends. Without cadence these are the old computePriority /
    // computeSuggestedQty exactly.
    const cadence = cadenceStats(recentByItem.get(item.id) ?? [], now)
    const planFields = {
      onHand, parLevel, minThreshold, targetToday, unit: item.unit,
      manualPriorityOverride: item.manualPriorityOverride, shelfLifeDays: item.shelfLifeDays, cadence,
    }
    const priority     = urgencyToPriority(effectiveUrgency(planFields, now.getTime()))
    const suggestedQty = cappedSuggestedQty(planFields)

    // Run-sheet timing: the recipe method, else the recipe's minute columns.
    const times = {
      linkedRecipe: item.linkedRecipe
        ? { activeMinutes: item.linkedRecipe.activeMinutes, passiveMinutes: item.linkedRecipe.passiveMinutes, passiveNote: item.linkedRecipe.passiveNote, stages: item.linkedRecipe.stages, method: item.linkedRecipe.method }
        : null,
    }
    const activeMinutes  = resolveActive(times)
    const passiveMinutes = resolvePassive(times)
    const passiveNote    = resolvePassiveNote(times)
    // The item's live job: its newest log, kept only while `isLiveLog` holds —
    // today's row, or an unfinished one the kitchen was posted earlier. Once the
    // newest row is a completed one from an earlier day, the item has no live job.
    const liveLog = item.logs[0] && isLiveLog(item.logs[0], today.getTime()) ? item.logs[0] : null
    const cook = liveLog?.assignedTo ? cookById.get(liveLog.assignedTo) : null
    const assignedCook = cook
      ? { id: cook.id, initials: cook.initials, name: cook.name, homeStation: cook.homeStation }
      : null

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

    // A job in flight is pipeline stock to the planner (evidence + exclusion;
    // the step still reads the stock — DONE is the only credit).
    const stages = resolveStages(item.linkedRecipe)
    const pipeline = liveLog
      ? pipelineOf({
          onHand, parLevel, minThreshold, targetToday, unit: item.unit,
          manualPriorityOverride: item.manualPriorityOverride,
          activeMinutes, passiveMinutes, estimatedPrepTime: item.estimatedPrepTime ?? null,
          linkedRecipe: item.linkedRecipe ? { stages, baseYieldQty: Number(item.linkedRecipe.baseYieldQty), yieldUnit: item.linkedRecipe.yieldUnit } : null,
          todayLog: {
            status: liveLog.status,
            startedAt: liveLog.startedAt?.toISOString() ?? null,
            stageIndex: liveLog.stageIndex,
            stageEnteredAt: liveLog.stageEnteredAt?.toISOString() ?? null,
            requiredQty: liveLog.requiredQty == null ? null : Number(liveLog.requiredQty),
          },
        }, Date.now())
      : null

    return {
      id: item.id,
      name: item.name,
      category: item.category,
      // `stations` is the truth (empty = any station); `station` is the display
      // label every row/tag reads — see stationLabel in prep-plan.ts.
      stations: item.stations,
      station: stationLabel(item),
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
      prepEnabled: item.prepEnabled,
      linkedRecipeId: item.linkedRecipeId,
      linkedRecipe: item.linkedRecipe
        ? {
            id: item.linkedRecipe.id,
            name: item.linkedRecipe.name,
            yieldUnit: item.linkedRecipe.yieldUnit,
            baseYieldQty: parseFloat(String(item.linkedRecipe.baseYieldQty)),
            // The resolved chain (null = unstaged) — the run sheet reads it for
            // the stage chip, rest rows and the Next button.
            stages: resolveStages(item.linkedRecipe),
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
      pipeline,
      cadence,
      revenueCenterId: item.revenueCenterId ?? null,
      activeMinutes,
      passiveMinutes,
      passiveNote,
      // The step-aware start-by is computed on the run sheet by withLadderTimes;
      // the API has no per-item anchor any more.
      startByMinutes: null,
      assignedCook,
      todayLog: liveLog,
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
