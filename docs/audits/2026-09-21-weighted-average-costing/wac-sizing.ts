/** READ-ONLY. For every non-PREP item: last vs 30-day average, basis, guard trips.
 *  For every recipe: cost per portion / batch cost LAST → AVG_30D. Run: npx tsx <this file> */
import { prisma } from '../../../src/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '../../../src/lib/item-model'
import { windowedAvgCost } from '../../../src/lib/cost-basis'
import { fetchRecipeWithCost } from '../../../src/lib/recipeCosts'

async function main() {
  const items = await prisma.inventoryItem.findMany({ where: { isActive: true, recipe: null, mergedIntoId: null }, select: { id: true, itemName: true, ...PRICING_SELECT } })
  const basis = await windowedAvgCost(items.map(i => i.id))
  const rows = items.map(i => { const b = basis.get(i.id)!; const last = pricePerBaseUnit(asChainItem(i)); return { item: i.itemName, unit: i.baseUnit, last, basis: b.basis, avg: b.avg?.pricePerBase ?? null, lines: b.avg?.lines ?? 0, excluded: b.avg?.excluded ?? 0, why: b.fallbackReason ?? '', delta: b.avg && last > 0 ? +((b.avg.pricePerBase / last - 1) * 100).toFixed(1) : null } })
  const onAvg = rows.filter(r => r.basis === 'AVG_30D')
  console.log(`${rows.length} items · ${onAvg.length} on AVG_30D · ${rows.filter(r => r.why === 'no-purchases').length} no purchases · ${rows.filter(r => r.why === 'implausible').length} implausible · ${rows.reduce((n, r) => n + r.excluded, 0)} excluded lines`)
  console.log('\n=== IMPLAUSIBLE ==='); console.table(rows.filter(r => r.why === 'implausible'))
  console.log('\n=== TOP MOVERS (items) ==='); console.table([...onAvg].sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)).slice(0, 25))

  const recipes = await prisma.recipe.findMany({ where: { isActive: true }, select: { id: true, name: true, type: true } })
  const out = []
  for (const r of recipes) {
    const [a, b] = await Promise.all([fetchRecipeWithCost(r.id), fetchRecipeWithCost(r.id, { basis: 'AVG_30D' })])
    if (!a || !b) continue
    out.push({ recipe: r.name, type: r.type, batchLast: +a.totalCost.toFixed(2), batchAvg: +b.totalCost.toFixed(2), ppLast: a.costPerPortion, ppAvg: b.costPerPortion, fcLast: a.foodCostPct, fcAvg: b.foodCostPct, avgLines: b.basisSummary.avgLines, lastLines: b.basisSummary.lastLines, deltaPct: a.totalCost > 0 ? +((b.totalCost / a.totalCost - 1) * 100).toFixed(1) : null })
  }
  console.log('\n=== TOP MOVERS (recipes) ==='); console.table(out.sort((x, y) => Math.abs(y.deltaPct ?? 0) - Math.abs(x.deltaPct ?? 0)).slice(0, 30))
  const { writeFileSync } = await import('node:fs')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(`wac-sizing-${stamp}.json`, JSON.stringify({ items: rows, recipes: out }, null, 2))
  console.log(`\nfull dump → wac-sizing-${stamp}.json`)
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
