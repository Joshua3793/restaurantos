/**
 * Verify one crisp pack-chain invariant across live inventory:
 *
 *     basePerUnit(item, item.countUnit) === 1   whenever countUnit === baseUnit
 *
 * When a chain names an intermediate level with the SAME token as the base unit
 * (e.g. `[{case,1},{each,70}]` on a COUNT item whose base unit is 'each'),
 * `levelBaseUnits()` keys the level by that token — so `basePerUnit(item,'each')`
 * resolves to the CASE size, not to 1. Every count screen and stock readout then
 * divides the on-hand base quantity by the case size.
 *
 * Valuation is unaffected (stockValue uses pricePerBaseUnit × stockOnHand), so
 * this is invisible on cost reports and only shows up as wrong counts.
 *
 * READ-ONLY. Run:
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *     scripts/audit-count-unit-collision.ts
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import { asChainItem, basePerUnit, countQty, pricePerBaseUnit } from '../src/lib/item-model'

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true, itemName: true, category: true, dimension: true, baseUnit: true,
      packChain: true, pricing: true, countUnit: true, stockOnHand: true,
      eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true,
    },
    orderBy: { itemName: 'asc' },
  })

  const bad: Array<Record<string, unknown>> = []

  for (const it of items) {
    const ci = asChainItem(it)
    const cu = ci.countUnit ?? 'each'
    if (cu !== ci.baseUnit) continue // countUnit is deliberately a pack level — fine
    const factor = basePerUnit(ci, cu)
    if (Math.abs(factor - 1) < 1e-9) continue

    bad.push({
      id: it.id,
      name: it.itemName,
      category: it.category,
      dimension: ci.dimension,
      baseUnit: ci.baseUnit,
      countUnit: cu,
      chain: ci.packChain,
      collisionFactor: factor,
      stockOnHandBase: Number(it.stockOnHand),
      displayedCountQty: countQty(ci, cu),
      trueCountQty: Number(it.stockOnHand),
      pricePerBaseUnit: pricePerBaseUnit(ci),
    })
  }

  console.log(`Active items checked: ${items.length}`)
  console.log(`countUnit === baseUnit but basePerUnit(countUnit) !== 1: ${bad.length}\n`)
  for (const b of bad) {
    console.log(
      `${String(b.name).padEnd(34)} ${String(b.dimension).padEnd(6)} ` +
        `factor=${String(b.collisionFactor).padStart(8)}  ` +
        `on hand ${b.stockOnHandBase} ${b.baseUnit} → count screen shows ${Number(b.displayedCountQty).toFixed(2)} ${b.countUnit}  ` +
        `chain=${JSON.stringify(b.chain)}`,
    )
  }

  const out = path.resolve(process.cwd(), process.argv[2] || 'scratch')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'count-unit-collisions.json'), JSON.stringify(bad, null, 2))
  console.log(`\nWrote ${path.join(out, 'count-unit-collisions.json')}`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
