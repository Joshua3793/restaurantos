// src/app/api/reports/menu-engineering/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { fetchRecipeWithCost } from '@/lib/recipeCosts'

export const dynamic = 'force-dynamic'

type Quadrant = 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG'

// GET /api/reports/menu-engineering?days=30
// Classifies MENU dishes by popularity (qty sold) × profitability (contribution
// margin = menuPrice − costPerPortion), split on the medians.
export async function GET(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const days = Number(new URL(req.url).searchParams.get('days') ?? 30)
  const since = new Date(); since.setDate(since.getDate() - days)

  const lineItems = await prisma.saleLineItem.findMany({
    where: { sale: { date: { gte: since } } },
    select: { recipeId: true, qtySold: true },
  })

  const qtyByRecipe = new Map<string, number>()
  for (const li of lineItems) qtyByRecipe.set(li.recipeId, (qtyByRecipe.get(li.recipeId) ?? 0) + li.qtySold)

  const ids = Array.from(qtyByRecipe.keys())
  const recipes = await Promise.all(ids.map(id => fetchRecipeWithCost(id)))

  const dishes = recipes.flatMap((r, i) => {
    if (!r || r.type !== 'MENU') return []
    const qty = qtyByRecipe.get(ids[i]) ?? 0
    const cost = r.costPerPortion
    const price = r.menuPrice
    const margin = price != null && cost != null ? price - cost : null
    return [{
      recipeId: r.id, name: r.name, qtySold: qty,
      menuPrice: price, costPerPortion: cost, margin,
      foodCostPct: r.foodCostPct,
    }]
  })

  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0
    const s = [...xs].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  const medPopularity = median(dishes.map(d => d.qtySold))
  const medMargin     = median(dishes.filter(d => d.margin != null).map(d => d.margin as number))

  const classified = dishes.map(d => {
    let quadrant: Quadrant | null = null
    if (d.margin != null) {
      const popular = d.qtySold >= medPopularity
      const profitable = d.margin >= medMargin
      quadrant = popular && profitable ? 'STAR'
        : popular && !profitable ? 'PLOWHORSE'
        : !popular && profitable ? 'PUZZLE' : 'DOG'
    }
    return { ...d, quadrant }
  })

  return NextResponse.json({
    days, medianPopularity: medPopularity, medianMargin: medMargin,
    dishes: classified.sort((a, b) => b.qtySold - a.qtySold),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
