import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildConsumptionMap, buildPurchaseMap, buildWastageMap, buildPrepMap, computeExpected } from '@/lib/count-expected'
import { resolveCountUom } from '@/lib/count-uom'
import { asChainItem, pricePerBaseUnit, withPpb } from '@/lib/item-model'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveScopedRcIds, scopeWhereFromParams, assertRcWritable } from '@/lib/rc-scope'

// ── GET /api/count/sessions ───────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)

  const scopeWhere = await scopeWhereFromParams(user, searchParams, { nullable: true })

  const sessions = await prisma.countSession.findMany({
    where: {
      AND: [
        // QUICK sessions back single-item quick-counts — keep them out of the
        // count-history list (snapshot/variance reports read them directly).
        { type: { not: 'QUICK' } },
        scopeWhere,
      ],
    },
    orderBy: { startedAt: 'desc' },
    include: { lines: { select: { countedQty: true, skipped: true } } },
  })

  return NextResponse.json(
    sessions.map(s => {
      const total   = s.lines.length
      const counted = s.lines.filter(l => l.countedQty !== null && !l.skipped).length
      const skipped = s.lines.filter(l => l.skipped).length
      const { lines, ...rest } = s
      return { ...rest, counts: { total, counted, skipped } }
    }),
    // The count page polls this list every 3s and refetches right after every
    // session mutation (create/finalize/delete/edit). A cached/SWR response replays
    // the stale pre-mutation snapshot for up to 10s — so never cache it.
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

// ── POST /api/count/sessions ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const {
    label, type = 'FULL', areaFilter, countedBy, sessionDate, revenueCenterId,
  } = await req.json()

  // An RC-scoped count must target an RC the user may write. An unscoped count
  // (no revenueCenterId — legacy "all items") is left to ADMIN/unscoped callers:
  // resolveScopedRcIds returns null for them, so a scoped user gets no broad reads.
  if (revenueCenterId) {
    try { await assertRcWritable(user, revenueCenterId) }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  } else {
    // A scoped user (resolveScopedRcIds !== null) may not create the legacy
    // all-items count — they must target one of their revenue centers.
    const allowed = await resolveScopedRcIds(user)
    if (allowed !== null) {
      return NextResponse.json({ error: 'A revenue center must be selected.' }, { status: 403 })
    }
  }

  const areaIds: string[] = areaFilter
    ? areaFilter.split(',').map((s: string) => s.trim()).filter(Boolean)
    : []

  const items = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      isStocked: true,
      ...(areaIds.length > 0 ? { storageAreaId: { in: areaIds } } : {}),
      // RC-scoped count → only items that are members of this revenue center
      // (ItemRevenueCenter). An unscoped count (no rcId) keeps the legacy "all items".
      ...(revenueCenterId ? { revenueCenters: { some: { revenueCenterId } } } : {}),
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })

  const itemIds = items.map(i => i.id)

  // Earliest "last count date" across all items — defines the lookback window
  const earliestLastCount = items
    .map(i => i.lastCountDate)
    .filter(Boolean)
    .sort((a, b) => ((a as Date) > (b as Date) ? 1 : -1))[0] as Date | undefined

  // Per-item cutoff so each item's expected qty is measured from its OWN last
  // count, not the batch's earliest (which double-counts movements already in a
  // recently-counted item's baseline).
  const cutoff = new Map<string, Date>()
  for (const i of items) if (i.lastCountDate) cutoff.set(i.id, i.lastCountDate)

  // ── Maps: consumption, purchases, wastage, prep ────────────────────────────
  const [consumptionMap, purchaseMap, wastageMap, prepMap] = await Promise.all([
    earliestLastCount
      ? buildConsumptionMap(earliestLastCount, revenueCenterId, cutoff)
      : Promise.resolve(new Map<string, number>()),
    earliestLastCount
      ? buildPurchaseMap(earliestLastCount, revenueCenterId, cutoff)
      : Promise.resolve(new Map<string, number>()),
    earliestLastCount
      ? buildWastageMap(earliestLastCount, itemIds, revenueCenterId, cutoff)
      : Promise.resolve(new Map<string, number>()),
    earliestLastCount
      ? buildPrepMap(earliestLastCount, revenueCenterId, cutoff)
      : Promise.resolve({ consumption: new Map<string, number>(), output: new Map<string, number>() }),
  ])

  // ── RC stock baseline ──────────────────────────────────────────────────────
  // For the default RC: baseline is global stockOnHand.
  // For a non-default RC: baseline is StockAllocation.quantity, falling back to
  // 0 (NOT global stockOnHand) when this RC has never been counted — otherwise
  // the first RC count would inflate the baseline by the entire warehouse total.
  const stockAllocationMap = new Map<string, number>()
  let isDefaultRc = false
  if (revenueCenterId && itemIds.length > 0) {
    const rc = await prisma.revenueCenter.findUnique({
      where: { id: revenueCenterId },
      select: { isDefault: true },
    })
    isDefaultRc = !!rc?.isDefault
    const allocations = await prisma.stockAllocation.findMany({
      where: { revenueCenterId, inventoryItemId: { in: itemIds } },
      select: { inventoryItemId: true, quantity: true },
    })
    for (const a of allocations) {
      stockAllocationMap.set(a.inventoryItemId, Number(a.quantity))
    }
  }

  const session = await prisma.countSession.create({
    data: {
      label:       label?.trim() || (type === 'FULL' ? 'Full count' : 'Partial count'),
      sessionDate: sessionDate ? new Date(sessionDate) : new Date(),
      type,
      areaFilter:      areaFilter || null,
      revenueCenterId: revenueCenterId || null,
      countedBy,
      lines: {
        create: items.map((item, i) => {
          const baseStock = revenueCenterId
            ? (stockAllocationMap.has(item.id)
                ? stockAllocationMap.get(item.id)!
                : (isDefaultRc ? Number(item.stockOnHand) : 0))
            : Number(item.stockOnHand)

          const expected = computeExpected(item.id, baseStock, consumptionMap, purchaseMap, wastageMap, prepMap.consumption, prepMap.output)

          return {
            inventoryItemId: item.id,
            expectedQty:     expected,
            // Derive from the purchase format (self-heals legacy items whose
            // stored countUOM no longer matches their structure).
            selectedUom:     resolveCountUom({
              dimension: item.dimension,
              baseUnit:  item.baseUnit,
              packChain: item.packChain,
              countUnit: item.countUnit,
            }) || item.baseUnit,
            priceAtCount:    pricePerBaseUnit(asChainItem(item)),
            sortOrder:       i,
          }
        }),
      },
    },
    include: {
      lines: {
        include: { inventoryItem: { include: { storageArea: true } } },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })

  // Enrich lines with per-RC parLevel from StockAllocation for display
  const parMap2 = new Map<string, number>()
  if (revenueCenterId) {
    const allocs = await prisma.stockAllocation.findMany({
      where: { revenueCenterId, inventoryItemId: { in: itemIds } },
      select: { inventoryItemId: true, parLevel: true },
    })
    for (const a of allocs) {
      if (a.parLevel != null) parMap2.set(a.inventoryItemId, Number(a.parLevel))
    }
  }
  const enrichedLines = session.lines.map(l => ({
    ...l,
    // withPpb re-populates the computed pricePerBaseUnit the count page reads.
    inventoryItem: { ...withPpb(l.inventoryItem), parLevel: parMap2.get(l.inventoryItemId) ?? null },
  }))

  return NextResponse.json(
    { ...session, lines: enrichedLines, counts: { total: session.lines.length, counted: 0, skipped: 0 } },
    { status: 201 },
  )
}
