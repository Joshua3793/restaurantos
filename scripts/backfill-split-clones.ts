/**
 * One-off: retroactively apply move-not-copy to invoice RC clones created before
 * the splitToSessionId flag existed. For each clone session (parentSessionId set),
 * flag the PARENT's scan items whose revenueCenterId matches the clone's RC by
 * setting splitToSessionId = <clone.id>, so they are excluded from spend
 * aggregation (the clone's copies remain the canonical home).
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Run: ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-split-clones.ts [--apply]
 */
import { prisma } from '../src/lib/prisma'

async function main() {
  const apply = process.argv.includes('--apply')

  const clones = await prisma.invoiceSession.findMany({
    where: { parentSessionId: { not: null }, revenueCenterId: { not: null } },
    select: { id: true, parentSessionId: true, revenueCenterId: true, invoiceNumber: true },
  })

  console.log(`Found ${clones.length} clone session(s).`)
  let totalFlagged = 0

  for (const clone of clones) {
    const where = {
      sessionId: clone.parentSessionId!,
      revenueCenterId: clone.revenueCenterId!,
      splitToSessionId: null,
    }
    const count = await prisma.invoiceScanItem.count({ where })
    if (count === 0) continue
    totalFlagged += count
    console.log(`  clone ${clone.invoiceNumber ?? clone.id}: ${count} parent line(s) → split`)
    if (apply) {
      await prisma.invoiceScanItem.updateMany({
        where,
        data: { splitToSessionId: clone.id },
      })
    }
  }

  console.log(
    apply
      ? `Applied: flagged ${totalFlagged} parent line(s).`
      : `Dry-run: would flag ${totalFlagged} parent line(s). Re-run with --apply to write.`,
  )
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
