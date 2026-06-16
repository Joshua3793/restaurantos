// Reads every item, asserts the chain-computed pricePerBaseUnit equals the
// stored legacy pricePerBaseUnit within 0.01%. This is the gate that must read
// OK before any reader is switched to compute-on-read. After the backfill made
// the legacy spine consistent with the chain, both are denominated per SI base,
// so a direct comparison is valid.
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/verify-item-model-parity.ts
import { prisma } from '../src/lib/prisma'
import { pricePerBaseUnit, asChainItem } from '../src/lib/item-model'

async function main() {
  const items = await prisma.inventoryItem.findMany()
  let bad = 0
  for (const it of items) {
    const chainPpb = pricePerBaseUnit(asChainItem(it as any))
    const legacyPpb = Number(it.pricePerBaseUnit)
    if (legacyPpb > 0 && Math.abs(chainPpb - legacyPpb) > legacyPpb * 1e-4) {
      bad++
      console.log(`MISMATCH ${it.itemName}: chain=${chainPpb} legacy=${legacyPpb}`)
    }
  }
  console.log(bad === 0 ? `OK — ${items.length} items match` : `${bad} mismatches`)
  await prisma.$disconnect()
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
