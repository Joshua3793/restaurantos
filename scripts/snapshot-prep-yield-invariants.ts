/**
 * Capture the derived values that MUST be identical before and after
 * scripts/migrate-prep-yield-units.ts:
 *
 *   - each PREP item's packChain factor and $/base-unit (the spine)
 *   - the scale factor every PrepLog resolves to (what credits theoretical stock)
 *
 * Writes JSON to the path given as the last argument.
 *
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *     scripts/snapshot-prep-yield-invariants.ts <out.json>
 */
try {
  process.loadEnvFile()
} catch (err) {
  console.error('Failed to load .env:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

import fs from 'fs'
import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { computeScale } from '../src/lib/prep-utils'
import { convertQty } from '../src/lib/uom'

const OUT = process.argv[process.argv.length - 1]

async function main() {
  const recipes = await prisma.recipe.findMany({
    where: { type: 'PREP' },
    select: {
      id: true, name: true, yieldUnit: true, baseYieldQty: true, inventoryItemId: true,
      prepItems: { select: { id: true, unit: true } },
    },
    orderBy: { name: 'asc' },
  })

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: recipes.map(r => r.inventoryItemId!).filter(Boolean) } },
    select: {
      id: true, itemName: true, dimension: true, baseUnit: true,
      packChain: true, pricing: true, countUnit: true, stockOnHand: true,
    },
  })
  const byId = new Map(items.map(i => [i.id, i]))

  const logs = await prisma.prepLog.findMany({
    where: { actualPrepQty: { not: null } },
    select: { id: true, prepItemId: true, actualPrepQty: true, requiredQty: true },
  })
  const unitOf = new Map<string, { unit: string; recipe: typeof recipes[number] }>()
  for (const r of recipes) for (const p of r.prepItems) unitOf.set(p.id, { unit: p.unit, recipe: r })

  const snap: Record<string, unknown> = {}

  for (const r of recipes) {
    const it = r.inventoryItemId ? byId.get(r.inventoryItemId) : null
    if (!it) continue
    const ci = asChainItem(it)
    snap[`item:${r.name}`] = {
      // The yield expressed in canonical base units — the spine's denominator.
      chainBase: (ci.packChain[0]?.per ?? 0),
      ppb: pricePerBaseUnit(ci),
      countUnit: it.countUnit,
      stockOnHand: Number(it.stockOnHand),
      // Yield restated in base units straight from the recipe (count-expected.ts:576).
      yieldInBase: convertQty(Number(r.baseYieldQty), r.yieldUnit, it.baseUnit),
    }
  }

  for (const l of logs) {
    const meta = unitOf.get(l.prepItemId)
    if (!meta) continue
    const { scale, unitMismatch } = computeScale(
      Number(l.actualPrepQty), meta.unit, meta.recipe.yieldUnit, Number(meta.recipe.baseYieldQty),
    )
    snap[`log:${l.id}`] = { scale, unitMismatch, requiredQty: l.requiredQty != null ? Number(l.requiredQty) : null }
  }

  fs.writeFileSync(OUT, JSON.stringify(snap, null, 1))
  console.log(`wrote ${Object.keys(snap).length} invariants → ${OUT}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
