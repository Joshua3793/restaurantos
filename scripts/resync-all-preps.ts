/**
 * Re-sync EVERY PREP recipe through the fixed syncPrepToInventory so all prep
 * InventoryItems use the canonical { unit:'batch', per:batchInBase } chain.
 *
 * The earlier repair-prep-canonical-base.ts only touched the 9 items whose
 * baseUnit was non-canonical. The ~108 canonical-base preps (g/ml/each yields)
 * still carry legacy chains named after the old countUOM, e.g. [{unit:'g', per:N}],
 * which shadow the base unit and show misleading "g (N g)" labels in Quick Count.
 * Base unit does NOT change for these, so stockOnHand needs no conversion — only
 * the chain link is renamed to 'batch' and countUnit becomes 'batch'.
 *
 * Dry by default; pass --apply to write.
 */
import { prisma } from '../src/lib/prisma'
import { syncPrepToInventory } from '../src/lib/recipeCosts'

const APPLY = process.argv.includes('--apply')

async function main() {
  const recs = await prisma.recipe.findMany({
    where: { type: 'PREP', inventoryItemId: { not: null } },
    select: { id: true, name: true, inventoryItemId: true },
  })
  let renamed = 0
  for (const r of recs) {
    const before = await prisma.inventoryItem.findUnique({
      where: { id: r.inventoryItemId! },
      select: { baseUnit: true, packChain: true },
    })
    const chain = (before?.packChain as { unit: string }[]) ?? []
    const alreadyBatch = chain.length === 1 && chain[0]?.unit === 'batch'
    if (alreadyBatch) continue
    renamed++
    if (APPLY) {
      await syncPrepToInventory(r.id)
    } else {
      console.log(`${r.name}: base=${before?.baseUnit} chain ${JSON.stringify(before?.packChain)} -> [{batch,...}]`)
    }
  }
  console.log(`\n${renamed} prep chain(s) ${APPLY ? 'RE-SYNCED to batch' : 'would be re-synced (dry run)'}.`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
