// src/app/api/insights/food-cost-variance/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { computePeriodCogs } from '@/lib/cogs'
import { theoreticalCostForLineItems } from '@/lib/theoretical-cost'

export const dynamic = 'force-dynamic'

// GET /api/insights/food-cost-variance
// Actual vs theoretical food cost % for the most recently closed count period
// (between the last two finalized counts). Global only.
export async function GET() {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const sessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED' },
    orderBy: { finalizedAt: 'desc' },
    take: 2,
    select: { id: true, finalizedAt: true, sessionDate: true },
  })

  if (sessions.length < 2 || !sessions[0].finalizedAt || !sessions[1].finalizedAt) {
    return NextResponse.json({
      needsCounts: true,
      message: 'Need at least two finalized counts to measure actual food cost.',
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const [closing, opening] = sessions // desc: [0]=latest, [1]=previous
  const startMs = new Date(opening.finalizedAt!).getTime()
  const endMs   = new Date(closing.finalizedAt!).getTime()

  const cogs = await computePeriodCogs(startMs, endMs)

  const lineItems = await prisma.saleLineItem.findMany({
    where: { sale: { date: { gte: new Date(startMs), lte: new Date(endMs) } } },
    select: { recipeId: true, qtySold: true },
  })
  const theo = await theoreticalCostForLineItems(lineItems)

  const actualFoodCostPct      = cogs.foodSales > 0 ? (cogs.cogs / cogs.foodSales) * 100 : null
  const theoreticalFoodCostPct = cogs.foodSales > 0 ? (theo.theoreticalCost / cogs.foodSales) * 100 : null
  const variancePctPoints =
    actualFoodCostPct != null && theoreticalFoodCostPct != null
      ? actualFoodCostPct - theoreticalFoodCostPct : null
  const varianceDollars = cogs.cogs - theo.theoreticalCost

  return NextResponse.json({
    needsCounts: false,
    globalOnly: true,
    period: { startDate: opening.finalizedAt, endDate: closing.finalizedAt },
    actualFoodCostPct,
    theoreticalFoodCostPct,
    variancePctPoints,
    varianceDollars,
    cogs: cogs.cogs,
    theoreticalCost: theo.theoreticalCost,
    foodSales: cogs.foodSales,
    coverage: { costed: theo.costedRecipes, total: theo.totalRecipes },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
