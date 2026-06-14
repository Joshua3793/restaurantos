// One-off backfill: every already-approved invoice line that was assigned to a
// non-default RC should have a StockAllocation row for (item, that RC), so the
// purchased item shows up in that RC's inventory list. Idempotent — safe to re-run.
//
// Mirrors the live rule now in approve/route.ts (registerAlloc): effective RC =
// line.revenueCenterId ?? session.revenueCenterId; only non-default RCs get a row.
import { prisma } from '../src/lib/prisma'

async function main() {
  const dryRun = process.argv.includes('--dry')
  const defaultRc = await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true, name: true } })
  const defaultRcId = defaultRc?.id ?? null
  console.log(`Default RC = ${defaultRc?.name ?? 'none'} (${defaultRcId})  ${dryRun ? '[DRY RUN]' : '[APPLY]'}`)

  const lines = await prisma.invoiceScanItem.findMany({
    where: { approved: true, matchedItemId: { not: null } },
    select: {
      matchedItemId: true,
      revenueCenterId: true,
      rawDescription: true,
      session: { select: { revenueCenterId: true } },
    },
  })

  // Dedup (itemId, rcId) where rcId is a non-default effective RC.
  const want = new Map<string, { itemId: string; rcId: string; sample: string }>()
  for (const l of lines) {
    const rcId = l.revenueCenterId ?? l.session?.revenueCenterId ?? null
    if (!l.matchedItemId || !rcId || rcId === defaultRcId) continue
    const key = `${rcId}::${l.matchedItemId}`
    if (!want.has(key)) want.set(key, { itemId: l.matchedItemId, rcId, sample: l.rawDescription })
  }
  console.log(`Candidate (item, RC) allocations: ${want.size}`)

  let created = 0, existing = 0
  for (const { itemId, rcId, sample } of want.values()) {
    const found = await prisma.stockAllocation.findUnique({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId: itemId } },
      select: { id: true },
    })
    if (found) { existing++; continue }
    if (dryRun) {
      console.log(`  WOULD CREATE  rc=${rcId.slice(0,8)} item=${itemId.slice(0,8)}  (${sample.slice(0,40)})`)
      created++
      continue
    }
    await prisma.stockAllocation.create({ data: { revenueCenterId: rcId, inventoryItemId: itemId, quantity: 0 } })
    console.log(`  CREATED       rc=${rcId.slice(0,8)} item=${itemId.slice(0,8)}  (${sample.slice(0,40)})`)
    created++
  }
  console.log(`\nDone. ${dryRun ? 'would create' : 'created'}=${created}  alreadyExisting=${existing}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
