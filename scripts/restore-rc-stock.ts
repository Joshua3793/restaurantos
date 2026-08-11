/**
 * Restore a revenue centre's StockAllocation rows from a backup written by
 * set-rc-stock-from-purchases.ts.
 *
 * Exact restore: every row in the backup is set back to its recorded quantity,
 * and any allocation row for that centre which is NOT in the backup is deleted
 * (it can only have been created by the run being undone).
 *
 * Dry run by default. Pass --apply to write.
 *
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *        scripts/restore-rc-stock.ts <backup.json> [--apply]
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'

const SRC = process.argv[2]
const APPLY = process.argv.includes('--apply')

interface Row { revenueCenterId: string; inventoryItemId: string; itemName: string; quantity: number }

async function main() {
  if (!SRC) { console.error('Usage: restore-rc-stock.ts <backup.json> [--apply]'); process.exit(1) }
  const rows: Row[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), SRC), 'utf8'))
  if (!rows.length) { console.error('Backup is empty'); process.exit(1) }

  const rcIds = [...new Set(rows.map((r) => r.revenueCenterId))]
  if (rcIds.length !== 1) { console.error('Backup spans more than one revenue centre'); process.exit(1) }
  const rcId = rcIds[0]
  const rc = await prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { name: true } })

  const current = await prisma.stockAllocation.findMany({
    where: { revenueCenterId: rcId },
    include: { inventoryItem: { select: { itemName: true } } },
  })
  const curBy = new Map(current.map((a) => [a.inventoryItemId, Number(a.quantity)]))
  const backupIds = new Set(rows.map((r) => r.inventoryItemId))

  const changes = rows
    .map((r) => ({ ...r, from: curBy.get(r.inventoryItemId) ?? null }))
    .filter((r) => r.from === null || Math.abs(r.from - r.quantity) > 1e-9)
  const extra = current.filter((a) => !backupIds.has(a.inventoryItemId))

  console.log(`Restore ${rc?.name ?? rcId} from ${path.basename(SRC)}`)
  console.log(`  backup rows ${rows.length} · live rows ${current.length}`)
  console.log(`  ${changes.length} rows to put back:`)
  for (const c of changes.sort((a, b) => b.quantity - a.quantity).slice(0, 40)) {
    console.log(`    ${c.itemName.slice(0, 34).padEnd(35)} ${String(c.from ?? 'absent').padStart(10)} → ${String(c.quantity).padStart(10)}`)
  }
  if (changes.length > 40) console.log(`    …and ${changes.length - 40} more`)
  if (extra.length) console.log(`  ${extra.length} rows created after the backup — will be DELETED: ${extra.map((e) => e.inventoryItem.itemName).join(', ')}`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.')
    await prisma.$disconnect()
    return
  }

  await prisma.$transaction([
    ...changes.map((c) => prisma.stockAllocation.upsert({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId: c.inventoryItemId } },
      update: { quantity: c.quantity },
      create: { revenueCenterId: rcId, inventoryItemId: c.inventoryItemId, quantity: c.quantity },
    })),
    ...extra.map((e) => prisma.stockAllocation.delete({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId: e.inventoryItemId } },
    })),
  ])
  console.log(`\nRESTORED — ${changes.length} rows put back, ${extra.length} deleted.`)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
