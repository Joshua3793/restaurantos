/**
 * Signals engine — 5 starter rules.
 *
 * Each rule produces zero or more `SignalCandidate` records. The /api/signals/refresh
 * endpoint runs all rules, upserts results into the Signal table (keyed by
 * fingerprint so re-running doesn't create duplicates), and prunes rows whose
 * underlying condition has resolved.
 *
 * Each signal ends with a verb (Principle 06). The verbHref points at the
 * page or modal where the action lives.
 */

import { prisma } from '@/lib/prisma'
import { fetchRecipeWithCost } from '@/lib/recipeCosts'

export interface SignalCandidate {
  fingerprint: string
  rule: string
  severity: 'critical' | 'warn' | 'info'
  title: string
  body: string
  verbLabel: string
  verbHref: string
  impactValue?: number
  itemId?: string | null
  recipeId?: string | null
}

// ── Rule 1: Price ↑ > 10% on item used in N recipes ────────────────────────
async function ruleIngredientPriceSpike(): Promise<SignalCandidate[]> {
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const alerts = await prisma.priceAlert.findMany({
    where: { acknowledged: false, createdAt: { gte: sevenDaysAgo } },
    include: {
      inventoryItem: {
        select: {
          id: true, itemName: true,
          recipeIngredients: { select: { recipeId: true } },
        },
      },
    },
  })

  const out: SignalCandidate[] = []
  for (const a of alerts) {
    const pct = Number(a.changePct)
    if (pct < 10) continue
    const recipeCount = new Set(a.inventoryItem.recipeIngredients.map(r => r.recipeId)).size
    if (recipeCount === 0) continue
    const impact = (Number(a.newPrice) - Number(a.previousPrice)) * recipeCount
    out.push({
      fingerprint: `price-spike:${a.inventoryItem.id}:${a.id}`,
      rule: 'PRICE_SPIKE',
      severity: pct > 25 ? 'critical' : 'warn',
      title: `${a.inventoryItem.itemName} up +${pct.toFixed(0)}%`,
      body: `Affects ${recipeCount} ${recipeCount === 1 ? 'recipe' : 'recipes'} — review prices or switch suppliers.`,
      verbLabel: 'Review',
      verbHref: '/invoices/price-alerts',
      impactValue: impact,
      itemId: a.inventoryItem.id,
    })
  }
  return out
}

// ── Rule 2: Recipe drift > target by > 3pp ─────────────────────────────────
async function ruleRecipeDrift(): Promise<SignalCandidate[]> {
  const defaultRc = await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { targetCostPct: true, targetFoodCostPct: true } })
  const targetPct = Number(defaultRc?.targetCostPct ?? defaultRc?.targetFoodCostPct ?? 27)

  // Recipes with explicit menu prices (MENU type) where we can compute food-cost
  const recipes = await prisma.recipe.findMany({
    where: { type: 'MENU', isActive: true, menuPrice: { not: null } },
    select: { id: true, name: true, menuPrice: true },
    take: 60,
  })

  const out: SignalCandidate[] = []
  for (const r of recipes) {
    if (r.menuPrice === null) continue
    const detail = await fetchRecipeWithCost(r.id).catch(() => null)
    if (!detail || !detail.totalCost) continue
    const fcPct = (detail.totalCost / Number(r.menuPrice)) * 100
    if (fcPct - targetPct < 3) continue
    out.push({
      fingerprint: `recipe-drift:${r.id}`,
      rule: 'RECIPE_DRIFT',
      severity: fcPct - targetPct > 6 ? 'critical' : 'warn',
      title: `${r.name} drifted to ${fcPct.toFixed(1)}% food cost`,
      body: `Target is ${targetPct.toFixed(1)}%. Bump menu price or trim costly ingredients.`,
      verbLabel: 'Open recipe',
      verbHref: `/menu?highlight=${r.id}`,
      impactValue: (fcPct - targetPct) * Number(r.menuPrice) / 100,
      recipeId: r.id,
    })
  }
  return out
}

// ── Rule 3: Count overdue > 4d ─────────────────────────────────────────────
async function ruleCountOverdue(): Promise<SignalCandidate[]> {
  const latest = await prisma.countSession.findFirst({
    where: { status: 'FINALIZED', finalizedAt: { not: null } },
    orderBy: { finalizedAt: 'desc' },
    select: { finalizedAt: true, sessionDate: true },
  })
  if (!latest?.finalizedAt) return []
  const days = Math.floor((Date.now() - latest.finalizedAt.getTime()) / 86_400_000)
  if (days <= 4) return []
  return [{
    fingerprint: 'count-overdue:global',
    rule: 'COUNT_OVERDUE',
    severity: days > 7 ? 'critical' : 'warn',
    title: `Stock count overdue — ${days} days`,
    body: `Theoretical-vs-actual drift widens with every day uncounted. Schedule a partial.`,
    verbLabel: 'Schedule count',
    verbHref: '/count',
    impactValue: days * 20, // rough drift estimate per day
  }]
}

// ── Rule 4: Wastage reason spike ───────────────────────────────────────────
async function ruleWastageSpike(): Promise<SignalCandidate[]> {
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const fourteenDaysAgo = new Date(); fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)

  const [thisWeek, lastWeek] = await Promise.all([
    prisma.wastageLog.groupBy({
      by: ['reason'],
      where: { date: { gte: sevenDaysAgo } },
      _sum: { costImpact: true },
    }),
    prisma.wastageLog.groupBy({
      by: ['reason'],
      where: { date: { gte: fourteenDaysAgo, lt: sevenDaysAgo } },
      _sum: { costImpact: true },
    }),
  ])

  const prevMap = new Map(lastWeek.map(r => [r.reason, Number(r._sum.costImpact ?? 0)]))
  const out: SignalCandidate[] = []
  for (const r of thisWeek) {
    const cur = Number(r._sum.costImpact ?? 0)
    const prev = prevMap.get(r.reason) ?? 0
    if (cur < 50 || cur <= prev * 1.5) continue
    out.push({
      fingerprint: `waste-spike:${r.reason}`,
      rule: 'WASTAGE_SPIKE',
      severity: cur > 200 ? 'critical' : 'warn',
      title: `Wastage spike: ${r.reason}`,
      body: `$${cur.toFixed(0)} this week vs $${prev.toFixed(0)} last week. Investigate before it compounds.`,
      verbLabel: 'Open log',
      verbHref: `/wastage?reason=${encodeURIComponent(r.reason)}`,
      impactValue: cur - prev,
    })
  }
  return out
}

// ── Rule 5: High-margin menu items not on a recent specials board ──────────
// Heuristic substitute for true menu engineering (no item-level sales).
// Surfaces top 3 highest-margin menu items as "promote" candidates.
async function ruleMenuPuzzle(): Promise<SignalCandidate[]> {
  const menuItems = await prisma.recipe.findMany({
    where: { type: 'MENU', isActive: true, menuPrice: { not: null } },
    select: { id: true, name: true, menuPrice: true },
    take: 40,
  })

  const enriched: Array<{ id: string; name: string; menuPrice: number; margin: number; pct: number }> = []
  for (const r of menuItems) {
    if (r.menuPrice === null) continue
    const detail = await fetchRecipeWithCost(r.id).catch(() => null)
    if (!detail || !detail.totalCost) continue
    const margin = Number(r.menuPrice) - detail.totalCost
    const pct = (margin / Number(r.menuPrice)) * 100
    if (margin > 0) enriched.push({ id: r.id, name: r.name, menuPrice: Number(r.menuPrice), margin, pct })
  }
  enriched.sort((a, b) => b.margin - a.margin)

  return enriched.slice(0, 3).map(r => ({
    fingerprint: `puzzle:${r.id}`,
    rule: 'MENU_PUZZLE',
    severity: 'info' as const,
    title: `Promote ${r.name}? Margin ${r.pct.toFixed(0)}%`,
    body: `Highest-margin dish on your menu — $${r.margin.toFixed(2)}/cover. Featuring it lifts blended food cost.`,
    verbLabel: 'Open dish',
    verbHref: `/menu?highlight=${r.id}`,
    impactValue: r.margin * 10,
    recipeId: r.id,
  }))
}

// ── Runner ─────────────────────────────────────────────────────────────────
export async function evaluateAllRules(): Promise<SignalCandidate[]> {
  const results = await Promise.allSettled([
    ruleIngredientPriceSpike(),
    ruleRecipeDrift(),
    ruleCountOverdue(),
    ruleWastageSpike(),
    ruleMenuPuzzle(),
  ])
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
}
