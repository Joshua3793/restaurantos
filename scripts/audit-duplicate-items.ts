/**
 * READ-ONLY. The item-consolidation worklist
 * (docs/superpowers/specs/2026-09-20-item-consolidation-design.md).
 *
 *   A. Items whose NAMES look like the same good split across rows. SEVERED = one
 *      row is in recipes while a sibling takes purchases no recipe ever depletes.
 *   B. Every stocked item that is bought but in no recipe, by spend, with the
 *      recipe-used items it might be a duplicate (or a variety) of.
 *
 * Nothing here is auto-mergeable: whether "Mushroom oyster" belongs under "Mixed
 * mushrooms" is a judgment call. Merge from the item drawer, one at a time.
 *
 * Run: npx tsx scripts/audit-duplicate-items.ts
 */
import { prisma } from '../src/lib/prisma'

const STOP = new Set([
  'the', 'and', 'of', 'with', 'in', 'for', 'fresh', 'frsh', 'frozen', 'frz', 'whole', 'case', 'bag', 'box',
  'kg', 'lb', 'lbs', 'oz', 'ml', 'ea', 'each', 'ct', 'pk', 'pack', 'bulk', 'large', 'lg', 'small', 'sm',
  'medium', 'med', 'jumbo', 'organic', 'org', 'local', 'bc', 'canada', 'grade',
])
/** Too generic to link two items on their own (section B only). */
const WEAK = new Set(['fancy', 'red', 'green', 'white', 'black', 'yellow', 'sliced', 'diced', 'ground', 'dry', 'dried', 'raw', 'mix', 'style', 'cut'])

const stem = (t: string) =>
  t.endsWith('ies') && t.length > 4 ? t.slice(0, -3) + 'y'
  : t.endsWith('oes') && t.length > 4 ? t.slice(0, -2)
  : t.endsWith('s') && !t.endsWith('ss') && t.length > 3 ? t.slice(0, -1)
  : t

function tokens(name: string): string[] {
  return [...new Set(
    name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/)
      .filter(t => t.length > 2 && !STOP.has(t)).map(stem),
  )]
}

function jaccard(a: string[], b: string[]) {
  const sa = new Set(a)
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : b.filter(t => sa.has(t)).length / union
}

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, recipe: null },
    select: {
      id: true, itemName: true, baseUnit: true, countUnit: true, category: true, packChain: true,
      stockOnHand: true, isStocked: true,
      supplierPrices: { select: { supplierName: true, isPrimary: true, supplierItemCode: true } },
      _count: { select: { recipeIngredients: true } },
    },
  })
  const bought = await prisma.invoiceScanItem.groupBy({
    by: ['matchedItemId'],
    where: { approved: true, splitToSessionId: null, matchedItemId: { not: null } },
    _count: { _all: true }, _sum: { rawLineTotal: true },
  })
  const buys = new Map(bought.map(p => [p.matchedItemId as string, { n: p._count._all, spend: Number(p._sum.rawLineTotal ?? 0) }]))
  const tok = new Map(items.map(i => [i.id, tokens(i.itemName)]))
  const used = (i: (typeof items)[number]) => i._count.recipeIngredients > 0
  const n = (id: string) => buys.get(id)?.n ?? 0

  // ── A. name-similar groups (union-find on Jaccard ≥ 0.67) ───────────────────
  const parent = new Map(items.map(i => [i.id, i.id]))
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)! } return x }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = tok.get(items[i].id)!, b = tok.get(items[j].id)!
    if (a.length && b.length && jaccard(a, b) >= 0.67) parent.set(find(items[i].id), find(items[j].id))
  }
  const groups = new Map<string, typeof items>()
  for (const it of items) groups.set(find(it.id), [...(groups.get(find(it.id)) ?? []), it])
  const dup = [...groups.values()].filter(g => g.length > 1).sort((a, b) => a[0].itemName.localeCompare(b[0].itemName))

  let severed = 0
  console.log('A. NAME-SIMILAR GROUPS\n')
  for (const g of dup) {
    const flag = g.some(used) && g.some(i => !used(i) && n(i.id) > 0)
    if (flag) severed++
    console.log(`${flag ? '⚠️  SEVERED' : '   similar'}  [${tok.get(g[0].id)!.join(' ')}]`)
    for (const i of g) {
      const chain = (i.packChain as { unit: string; per: number }[]).map(l => `${l.per}/${l.unit}`).join(' › ')
      const offers = i.supplierPrices.map(o => `${o.supplierName}${o.isPrimary ? '*' : ''}${o.supplierItemCode ? '#' + o.supplierItemCode : ''}`).join(', ')
      console.log(`     - ${i.itemName.padEnd(42)} recipes=${String(i._count.recipeIngredients).padStart(2)}  purchases=${String(n(i.id)).padStart(3)}  stock=${Number(i.stockOnHand).toFixed(1)} ${i.baseUnit}  count=${i.countUnit}  chain=[${chain}]  offers=[${offers}]`)
    }
    console.log()
  }

  // ── B. bought but in no recipe ──────────────────────────────────────────────
  const freq = new Map<string, number>()
  for (const t of tok.values()) for (const x of t) freq.set(x, (freq.get(x) ?? 0) + 1)
  const inRecipes = items.filter(used)
  const orphans = items.filter(i => i.isStocked && !used(i) && n(i.id) > 0).sort((a, b) => buys.get(b.id)!.spend - buys.get(a.id)!.spend)
  const withSib: string[] = [], alone: string[] = []
  let sibSpend = 0, aloneSpend = 0
  for (const o of orphans) {
    const rare = tok.get(o.id)!.filter(t => !WEAK.has(t) && (freq.get(t) ?? 0) <= 8)
    const sibs = inRecipes.filter(u => tok.get(u.id)!.some(t => rare.includes(t)))
    const b = buys.get(o.id)!
    if (sibs.length) {
      sibSpend += b.spend
      const sup = [...new Set(o.supplierPrices.map(x => x.supplierName))].join('/')
      withSib.push(`  ${o.itemName.slice(0, 40).padEnd(40)} ${String(b.n).padStart(3)}x $${b.spend.toFixed(0).padStart(6)} ${o.baseUnit.padEnd(4)} [${sup}]  →  ${sibs.slice(0, 4).map(u => `${u.itemName} (${u._count.recipeIngredients}r,${u.baseUnit})`).join(' | ')}`)
    } else { aloneSpend += b.spend; alone.push(`${o.itemName.slice(0, 34)} ($${b.spend.toFixed(0)}, ${o.category})`) }
  }
  console.log('B. BOUGHT BUT IN NO RECIPE  (purchases, spend, base, suppliers)  →  candidate recipe-used siblings\n')
  console.log(withSib.join('\n'))
  console.log(`\n   no sibling (supplies / retail / no recipe yet):\n   ${alone.join('; ')}`)

  console.log('\n──────────────────────────────────────────────────────────────')
  console.log(`Active purchasable items:                   ${items.length}`)
  console.log(`Name-similar groups / SEVERED:              ${dup.length} / ${severed}`)
  console.log(`Bought but in no recipe:                    ${orphans.length}  ($${(sibSpend + aloneSpend).toFixed(0)})`)
  console.log(`  …with a plausible recipe-used sibling:    ${withSib.length}  ($${sibSpend.toFixed(0)})`)
  console.log(`  …with none:                               ${alone.length}  ($${aloneSpend.toFixed(0)})`)
  console.log(`Items already pooling 2+ supplier offers:   ${items.filter(i => i.supplierPrices.length > 1).length}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
