// src/app/api/insights/variance-lines/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { lineCountedBase } from '@/lib/count-uom'
import { scopeWhereFromParams } from '@/lib/rc-scope'

export const dynamic = 'force-dynamic'

// GET /api/insights/variance-lines?days=7  (or ?startDate=&endDate=)
//
// Per-item variance from FINALIZED count sessions over a trailing window.
// This is the canonical, purchase-aware variance the count engine already
// computes and PERSISTS on each CountLine:
//   - expectedQty   = theoretical on-hand at count time (getTheoreticalStockMap:
//                     baseline count + purchases + prep − consumption − wastage)
//   - countedQty    = physically counted (in selectedUom; converted to base here)
//   - varianceCost  = signed $ drift (counted − expected) × price at count
// We read those stored values rather than re-deriving from sales (the old
// /reports/theoretical-usage path ignored purchases, so its "variance" was noise).
//
// Aggregation: a count line is one measured drift event for one (item, RC). We
// keep only the MOST RECENT line per (item, RC) inside the window (so a quick
// count followed by a full count of the same item in the same RC isn't double
// counted), then SUM across RCs per item to get the business-wide drift.
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const daysParam = Number(searchParams.get('days'))
  const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : 7

  const startDateParam = searchParams.get('startDate')
  const endDateParam   = searchParams.get('endDate')
  const endAt   = endDateParam   ? new Date(`${endDateParam}T23:59:59.999Z`)   : new Date()
  const startAt = startDateParam
    ? new Date(`${startDateParam}T00:00:00.000Z`)
    : new Date(endAt.getTime() - days * 24 * 60 * 60 * 1000)

  // Count sessions are RC-scoped (nullable → default/shared reads null-RC too).
  const countScope = await scopeWhereFromParams(user, searchParams, { nullable: true })

  const lines = await prisma.countLine.findMany({
    where: {
      countedQty: { not: null },
      session: {
        status: 'FINALIZED',
        sessionDate: { gte: startAt, lte: endAt },
        ...countScope,
      },
    },
    select: {
      expectedQty: true,
      countedQty: true,
      selectedUom: true,
      entries: true,
      variancePct: true,
      varianceCost: true,
      priceAtCount: true,
      session: { select: { sessionDate: true, revenueCenterId: true } },
      inventoryItem: {
        select: {
          id: true, itemName: true, category: true,
          baseUnit: true, dimension: true, packChain: true, countUnit: true,
        },
      },
    },
  })

  // ── 1. Keep the most recent line per (item, RC) ──────────────────────────
  type Line = (typeof lines)[number]
  const latestPerItemRc = new Map<string, Line>()
  for (const l of lines) {
    const key = `${l.inventoryItem.id}::${l.session.revenueCenterId ?? 'null'}`
    const prev = latestPerItemRc.get(key)
    if (!prev || new Date(l.session.sessionDate) > new Date(prev.session.sessionDate)) {
      latestPerItemRc.set(key, l)
    }
  }

  // ── 2. Sum across RCs per item ───────────────────────────────────────────
  const byItem = new Map<string, {
    inventoryItemId: string
    itemName: string
    category: string
    baseUnit: string
    theoreticalQty: number
    countedQty: number
    varianceValue: number
    priceAtCount: number
    latestDate: number
  }>()

  for (const l of latestPerItemRc.values()) {
    const it = l.inventoryItem
    const dims = { dimension: it.dimension, baseUnit: it.baseUnit, packChain: it.packChain, countUnit: it.countUnit }
    const expectedBase = Number(l.expectedQty)
    const countedBase  = lineCountedBase(l, dims)
    const varianceValue = l.varianceCost != null ? Number(l.varianceCost) : (countedBase - expectedBase) * Number(l.priceAtCount)
    const sessionMs = new Date(l.session.sessionDate).getTime()

    const agg = byItem.get(it.id)
    if (!agg) {
      byItem.set(it.id, {
        inventoryItemId: it.id,
        itemName: it.itemName,
        category: it.category ?? '',
        baseUnit: it.baseUnit,
        theoreticalQty: expectedBase,
        countedQty: countedBase,
        varianceValue,
        priceAtCount: Number(l.priceAtCount),
        latestDate: sessionMs,
      })
    } else {
      agg.theoreticalQty += expectedBase
      agg.countedQty     += countedBase
      agg.varianceValue  += varianceValue
      if (sessionMs >= agg.latestDate) { agg.latestDate = sessionMs; agg.priceAtCount = Number(l.priceAtCount) }
    }
  }

  const items = [...byItem.values()].map(a => ({
    inventoryItemId: a.inventoryItemId,
    itemName: a.itemName,
    category: a.category,
    baseUnit: a.baseUnit,
    theoreticalQty: a.theoreticalQty,
    countedQty: a.countedQty,
    varianceQty: a.countedQty - a.theoreticalQty,
    varianceValue: a.varianceValue,
    pricePerBaseUnit: a.priceAtCount,
  }))

  const totalVarianceValue = items.reduce((s, r) => s + r.varianceValue, 0)

  return NextResponse.json({
    items,
    totalVarianceValue,
    needsCounts: items.length === 0,
    sessionWindowDays: days,
    startDate: startAt.toISOString().slice(0, 10),
    endDate: endAt.toISOString().slice(0, 10),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
