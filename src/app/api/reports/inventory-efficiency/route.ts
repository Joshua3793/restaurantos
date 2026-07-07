// src/app/api/reports/inventory-efficiency/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { computePeriodCogs } from '@/lib/cogs'
import { resolveLocationRcIds } from '@/lib/rc-scope'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'

export const dynamic = 'force-dynamic'

// GET /api/reports/inventory-efficiency?days=30[&rcId&isDefault&locationId]
// Inventory turns and days-on-hand from trailing-window COGS + current on-hand.
// Scoped to the active RC (or a location's child RCs) when passed, so the figure
// lines up with the RC-scoped on-hand value shown next to it on the Pass; ΣRC
// when unscoped. A non-default RC without its own FULL counts falls to
// needsCounts (daysOnHand null) — honest, not a global number in disguise.
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const sp = new URL(req.url).searchParams
  const days = Number(sp.get('days') ?? 30)
  const rcId = sp.get('rcId')
  const isDefault = sp.get('isDefault') === 'true'
  const locationId = sp.get('locationId')
  const endMs = Date.now()
  const startMs = endMs - days * 86_400_000

  // Which concrete RCs are in scope. null = unscoped (global, existing behavior).
  let scopes: { rcId: string; isDefault: boolean }[] | null = null
  if (locationId) {
    const ids = await resolveLocationRcIds(user, locationId)
    const rcs = await prisma.revenueCenter.findMany({ where: { id: { in: ids } }, select: { id: true, isDefault: true } })
    scopes = rcs.map(r => ({ rcId: r.id, isDefault: r.isDefault }))
  } else if (rcId) {
    scopes = [{ rcId, isDefault }]
  }

  // COGS = ΣRC of each scope bracketed by its own counts (global when unscoped).
  const cogsParts = scopes
    ? await Promise.all(scopes.map(s => computePeriodCogs(startMs, endMs, s)))
    : [await computePeriodCogs(startMs, endMs)]
  const openingValue = cogsParts.reduce((s, c) => s + c.openingValue, 0)
  const closingValue = cogsParts.reduce((s, c) => s + c.closingValue, 0)
  const periodCogs   = cogsParts.reduce((s, c) => s + c.cogs, 0)
  const needsCounts  = cogsParts.some(c => c.needsCounts)

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, isStocked: true },
    select: { stockOnHand: true, ...PRICING_SELECT, stockAllocations: { select: { quantity: true, revenueCenterId: true } } },
  })
  // On-hand mirrors the dashboard's per-RC stock model: a default RC in scope
  // contributes the base pool (stockOnHand); each non-default RC contributes its
  // allocation qty (default RCs hold no allocation rows). Unscoped = pool only,
  // unchanged from before.
  const rcIdSet = scopes ? new Set(scopes.map(s => s.rcId)) : null
  const defaultInScope = scopes ? scopes.some(s => s.isDefault) : false
  const onHandValue = items.reduce((sum, it) => {
    const qty = rcIdSet
      ? (defaultInScope ? Number(it.stockOnHand) : 0)
        + it.stockAllocations.filter(a => a.revenueCenterId != null && rcIdSet.has(a.revenueCenterId))
            .reduce((s, a) => s + Number(a.quantity), 0)
      : Number(it.stockOnHand)
    return sum + qty * pricePerBaseUnit(asChainItem(it))
  }, 0)

  const avgInventory = (openingValue + closingValue) / 2
  const dailyCogs = days > 0 ? periodCogs / days : 0

  // Negative period COGS (closing > opening + purchases) yields a nonsensical
  // negative turnover ratio — clamp to null, mirroring daysOnHand. Raw
  // periodCogs stays in the payload for diagnostics; needsCounts flags why.
  const turns      = avgInventory > 0 && periodCogs >= 0 ? periodCogs / avgInventory : null
  const turnsAnnual = turns != null ? turns * (365 / days) : null
  const daysOnHand = dailyCogs > 0 ? onHandValue / dailyCogs : null

  return NextResponse.json({
    days, onHandValue, avgInventory, periodCogs,
    turns, turnsAnnual, daysOnHand,
    needsCounts,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
