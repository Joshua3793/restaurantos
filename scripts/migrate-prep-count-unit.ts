/**
 * Move PREP-linked inventory items off `countUnit = 'batch'` and onto the
 * recipe's own yield unit (kg / l / lb / g / ml / each).
 *
 * WHAT THIS DOES NOT DO: convert any stored quantity. Nothing needs converting —
 * stockOnHand, lastCountQty and InventorySnapshot.qtyOnHand are all denominated
 * in the item's canonical baseUnit (g/ml/each), not in countUnit. countUnit is
 * only the DEFAULT unit the count screen and the inventory readout display in.
 *
 * The 'batch' link stays in each item's packChain, so:
 *   - "1 batch" remains selectable in a count session, and
 *   - historical CountLine rows stored with selectedUom='batch' keep resolving
 *     to exactly the quantity they always did.
 *
 * Dry run (default) prints the before/after readout and verifies that the new
 * unit actually resolves through the count converters.
 *
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *     scripts/migrate-prep-count-unit.ts [--apply]
 */
try {
  process.loadEnvFile()
} catch (err) {
  console.error('Failed to load .env:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

import { prisma } from '../src/lib/prisma'
import { prepCountUnitFor } from '../src/lib/recipeCosts'
import { resolveCountUom, convertBaseToCountUom, getCountableUoms } from '../src/lib/count-uom'

const APPLY = process.argv.includes('--apply')

async function main() {
  const recipes = await prisma.recipe.findMany({
    where: { type: 'PREP', inventoryItemId: { not: null } },
    select: { id: true, name: true, yieldUnit: true, inventoryItemId: true },
    orderBy: { name: 'asc' },
  })

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: recipes.map(r => r.inventoryItemId!) } },
    select: {
      id: true, itemName: true, dimension: true, baseUnit: true,
      packChain: true, countUnit: true, stockOnHand: true,
    },
  })
  const byId = new Map(items.map(i => [i.id, i]))

  const planned: Array<{ id: string; name: string; from: string; to: string }> = []
  const problems: string[] = []

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${recipes.length} PREP recipes\n`)
  console.log(['item', 'yield', 'countUnit', '→', 'new', 'stock before', 'stock after'].join(' | '))

  for (const r of recipes) {
    const it = byId.get(r.inventoryItemId!)
    if (!it) { problems.push(`${r.name}: linked inventory item is missing`); continue }

    const to = prepCountUnitFor(r.yieldUnit)
    const dims = {
      dimension: it.dimension, baseUnit: it.baseUnit,
      packChain: it.packChain, countUnit: to,
    }

    // The new unit must survive resolveCountUom (i.e. it is a chain level or a
    // same-dimension unit), otherwise the count screen would silently fall back
    // to the leaf level and every entered quantity would be scaled by a batch.
    const resolved = resolveCountUom(dims)
    if (resolved !== to) {
      problems.push(`${it.itemName}: countUnit '${to}' does not resolve (falls back to '${resolved}') — SKIPPED`)
      continue
    }
    // …and it must be offered in the count session's unit picker.
    const options = getCountableUoms(dims).map(u => u.label.toLowerCase())
    if (!options.includes(to.toLowerCase())) {
      problems.push(`${it.itemName}: '${to}' is not among count options [${options.join(', ')}] — SKIPPED`)
      continue
    }

    const base = Number(it.stockOnHand)
    const before = convertBaseToCountUom(base, it.countUnit, { ...dims, countUnit: it.countUnit })
    const after = convertBaseToCountUom(base, to, dims)

    console.log([
      it.itemName, `${r.yieldUnit}`, it.countUnit, '→', to,
      `${before.toFixed(2)} ${it.countUnit}`, `${after.toFixed(2)} ${to}`,
    ].join(' | '))

    if (it.countUnit !== to) planned.push({ id: it.id, name: it.itemName, from: it.countUnit, to })
  }

  console.log(`\n${planned.length} item(s) to change; ${problems.length} problem(s).`)
  for (const p of problems) console.log(`  ⚠ ${p}`)

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.')
    return
  }

  for (const p of planned) {
    await prisma.inventoryItem.update({ where: { id: p.id }, data: { countUnit: p.to } })
  }
  console.log(`\nUpdated ${planned.length} item(s).`)

  const left = await prisma.inventoryItem.count({
    where: { id: { in: [...byId.keys()] }, countUnit: 'batch' },
  })
  console.log(`PREP items still on countUnit='batch': ${left}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
