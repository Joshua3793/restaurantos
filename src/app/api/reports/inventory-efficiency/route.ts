// src/app/api/reports/inventory-efficiency/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { computePeriodCogs } from '@/lib/cogs'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'

export const dynamic = 'force-dynamic'

// GET /api/reports/inventory-efficiency?days=30
// Inventory turns and days-on-hand from trailing-window COGS + current on-hand.
export async function GET(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const days = Number(new URL(req.url).searchParams.get('days') ?? 30)
  const endMs = Date.now()
  const startMs = endMs - days * 86_400_000

  const cogs = await computePeriodCogs(startMs, endMs)

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: { stockOnHand: true, ...PRICING_SELECT },
  })
  const onHandValue = items.reduce((s, it) => s + Number(it.stockOnHand) * pricePerBaseUnit(asChainItem(it)), 0)

  const avgInventory = (cogs.openingValue + cogs.closingValue) / 2
  const periodCogs = cogs.cogs
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
    needsCounts: cogs.needsCounts,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
