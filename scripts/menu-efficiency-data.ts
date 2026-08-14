/**
 * Data pull for the 2026-08 menu & prep efficiency review (Tier 4 verification).
 *
 * Produces the numbers the cloud session could not access:
 *   A. Sales mix per MENU recipe (last N days, Toast rows supersede same-day manual)
 *   B. Contribution margin per dish (live plate cost via fetchRecipeWithCost)
 *   C. PREP recipe → menu-dish reachability (transitive through nested preps),
 *      flagging preps no active menu dish touches
 *   D. Active minutes per prep item (override ?? linked recipe)
 *
 * Read-only — no writes. Requires DATABASE_URL (run locally, not in a
 * credential-less container).
 *
 * Run:  npx tsx scripts/menu-efficiency-data.ts [days]   (default 42)
 * Output: stdout + docs/audits/2026-08-14-menu-efficiency/data.md
 */
import * as fs from 'fs'
import * as path from 'path'
import { prisma } from '../src/lib/prisma'
import { fetchRecipeWithCost } from '../src/lib/recipeCosts'

const days = Number(process.argv[2] ?? 42)
const since = new Date(Date.now() - days * 86_400_000)

const pct = (n: number) => `${n.toFixed(1)}%`
const money = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`)

async function salesMix() {
  // Toast supersedes same-day manual rows for the same RC.
  const entries = await prisma.salesEntry.findMany({
    where: { date: { gte: since }, periodType: 'day' },
    select: { id: true, date: true, revenueCenterId: true, source: true },
  })
  const dayKey = (e: { date: Date; revenueCenterId: string }) =>
    `${e.date.toISOString().slice(0, 10)}|${e.revenueCenterId}`
  const toastDays = new Set(entries.filter(e => e.source === 'toast').map(dayKey))
  const liveIds = entries
    .filter(e => e.source === 'toast' || !toastDays.has(dayKey(e)))
    .map(e => e.id)

  const lines = await prisma.saleLineItem.findMany({
    where: { saleId: { in: liveIds } },
    select: {
      qtySold: true,
      recipeId: true,
      recipe: { select: { name: true, type: true, isActive: true, menuPrice: true } },
    },
  })

  const byRecipe = new Map<string, { name: string; qty: number; menuPrice: number | null; isActive: boolean }>()
  for (const l of lines) {
    const cur = byRecipe.get(l.recipeId) ?? {
      name: l.recipe.name,
      qty: 0,
      menuPrice: l.recipe.menuPrice == null ? null : Number(l.recipe.menuPrice),
      isActive: l.recipe.isActive,
    }
    cur.qty += l.qtySold
    byRecipe.set(l.recipeId, cur)
  }
  return byRecipe
}

async function prepReachability() {
  const ings = await prisma.recipeIngredient.findMany({
    where: { linkedRecipeId: { not: null } },
    select: { recipeId: true, linkedRecipeId: true },
  })
  const parentsOf = new Map<string, string[]>()
  for (const i of ings) {
    const arr = parentsOf.get(i.linkedRecipeId!) ?? []
    arr.push(i.recipeId)
    parentsOf.set(i.linkedRecipeId!, arr)
  }
  const recipes = await prisma.recipe.findMany({
    select: { id: true, name: true, type: true, isActive: true },
  })
  const rById = new Map(recipes.map(r => [r.id, r]))

  function menuUsers(prepId: string, seen = new Set<string>()): Set<string> {
    const out = new Set<string>()
    for (const p of parentsOf.get(prepId) ?? []) {
      if (seen.has(p)) continue
      seen.add(p)
      const r = rById.get(p)
      if (!r) continue
      if (r.type === 'MENU' && r.isActive) out.add(r.name)
      else if (r.type === 'PREP') for (const m of menuUsers(p, seen)) out.add(m)
    }
    return out
  }

  return recipes
    .filter(r => r.type === 'PREP' && r.isActive)
    .map(r => ({ id: r.id, name: r.name, dishes: [...menuUsers(r.id)].sort() }))
    .sort((a, b) => a.dishes.length - b.dishes.length || a.name.localeCompare(b.name))
}

async function prepMinutes() {
  const items = await prisma.prepItem.findMany({
    where: { isActive: true },
    select: {
      name: true,
      station: true,
      activeMinutesOverride: true,
      linkedRecipe: { select: { activeMinutes: true } },
    },
  })
  return items
    .map(i => ({
      name: i.name,
      station: i.station ?? '—',
      activeMinutes: i.activeMinutesOverride ?? i.linkedRecipe?.activeMinutes ?? null,
    }))
    .sort((a, b) => (b.activeMinutes ?? -1) - (a.activeMinutes ?? -1))
}

async function main() {
  console.log(`Menu efficiency data pull — last ${days} days (since ${since.toISOString().slice(0, 10)})\n`)

  const mix = await salesMix()
  const totalQty = [...mix.values()].reduce((s, r) => s + r.qty, 0)

  // Margin per active MENU recipe (plate cost computed live off the spine)
  const menuRecipes = await prisma.recipe.findMany({
    where: { type: 'MENU', isActive: true },
    select: { id: true, name: true },
  })
  const costs = new Map<string, { costPerPortion: number | null; foodCostPct: number | null }>()
  for (const r of menuRecipes) {
    const c = await fetchRecipeWithCost(r.id)
    costs.set(r.id, {
      costPerPortion: c?.costPerPortion ?? null,
      foodCostPct: c?.foodCostPct ?? null,
    })
  }

  const rows = menuRecipes
    .map(r => {
      const m = mix.get(r.id)
      const c = costs.get(r.id)
      const qty = m?.qty ?? 0
      const price = m?.menuPrice ?? null
      const margin = price != null && c?.costPerPortion != null ? price - c.costPerPortion : null
      return {
        name: r.name,
        qty,
        mixPct: totalQty > 0 ? (qty / totalQty) * 100 : 0,
        price,
        cost: c?.costPerPortion ?? null,
        margin,
        marginDollars: margin != null ? margin * qty : null,
      }
    })
    .sort((a, b) => b.qty - a.qty)

  const reach = await prepReachability()
  const minutes = await prepMinutes()

  const md: string[] = []
  md.push(`# Menu efficiency data — last ${days} days\n`)
  md.push(`Generated ${new Date().toISOString().slice(0, 10)}. Total items sold in window: ${totalQty}.\n`)

  md.push(`## A+B. Sales mix & margin per active MENU recipe (sorted by qty sold)\n`)
  md.push(`| Dish | Qty sold | Mix % | Price | Plate cost | Margin | Margin $ total |`)
  md.push(`|---|---:|---:|---:|---:|---:|---:|`)
  for (const r of rows)
    md.push(`| ${r.name} | ${r.qty} | ${pct(r.mixPct)} | ${money(r.price)} | ${money(r.cost)} | ${money(r.margin)} | ${money(r.marginDollars)} |`)

  md.push(`\n## C. PREP recipes by menu-dish reach (fewest dishes first — 0 = dead or catering-only)\n`)
  md.push(`| Prep recipe | # dishes | Dishes |`)
  md.push(`|---|---:|---|`)
  for (const p of reach) md.push(`| ${p.name} | ${p.dishes.length} | ${p.dishes.join(' · ') || '**NONE**'} |`)

  md.push(`\n## D. Prep items by active minutes\n`)
  md.push(`| Prep item | Station | Active min |`)
  md.push(`|---|---|---:|`)
  for (const m of minutes) md.push(`| ${m.name} | ${m.station} | ${m.activeMinutes ?? '—'} |`)

  const out = md.join('\n')
  const outPath = path.join(__dirname, '..', 'docs', 'audits', '2026-08-14-menu-efficiency', 'data.md')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, out)
  console.log(out)
  console.log(`\nWritten to ${outPath}`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
