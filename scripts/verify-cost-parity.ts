// Read-only parity check for the one-cost-function migration.
// For every active item: the LAST basis through the reader API must equal the
// engine's direct pricePerBaseUnit(asChainItem(row)) EXACTLY. Also reports how
// many items currently cost on the 30-day average (information only).
//
// Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-cost-parity.ts
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { itemCosts } from '../src/lib/cost-basis'

async function main() {
  const rows = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: { id: true, itemName: true, ...PRICING_SELECT },
  })
  const ids = rows.map((r) => r.id)
  const last = await itemCosts(ids, 'LAST')
  const avg = await itemCosts(ids, 'AVG_30D')

  let bad = 0
  for (const r of rows) {
    const direct = pricePerBaseUnit(asChainItem(r))
    const viaLib = last.get(r.id)?.pricePerBase
    if (viaLib !== direct) {
      bad++
      console.log(`MISMATCH ${r.id} ${r.itemName}: engine=${direct} lib=${viaLib}`)
    }
    if (!avg.has(r.id)) { bad++; console.log(`MISSING AVG entry ${r.id} ${r.itemName}`) }
  }
  const onAvg = Array.from(avg.values()).filter((b) => b.basis === 'AVG_30D').length
  console.log(bad === 0
    ? `OK — ${rows.length} items match (LAST); ${onAvg} on the 30-day average`
    : `FAIL — ${bad} mismatches`)
  await prisma.$disconnect()
  if (bad > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
