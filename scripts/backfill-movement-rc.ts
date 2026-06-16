/**
 * One-time: assign existing null-RC movements to the default revenue center. Idempotent.
 * NOTE: this ran before revenueCenterId was made NOT NULL on the movement tables, so the
 * `{ revenueCenterId: null }` filters can no longer match anything. They're cast to keep the
 * script compiling as a historical/no-op safety re-run; the schema now enforces the invariant.
 */
import { prisma } from '../src/lib/prisma'

// The movement RC columns are NOT NULL now, so Prisma's generated where-types reject `null`.
const nullRcWhere = { revenueCenterId: null } as never

async function main() {
  const def = await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true, name: true } })
  if (!def) throw new Error('No default revenue center found')
  console.log(`Default RC: ${def.name} (${def.id})`)

  const prep  = await prisma.prepLog.updateMany({   where: nullRcWhere, data: { revenueCenterId: def.id } })
  const sales = await prisma.salesEntry.updateMany({ where: nullRcWhere, data: { revenueCenterId: def.id } })
  const waste = await prisma.wastageLog.updateMany({ where: nullRcWhere, data: { revenueCenterId: def.id } })

  console.log(`Backfilled → PrepLog ${prep.count}, SalesEntry ${sales.count}, WastageLog ${waste.count}`)
  const remaining =
    (await prisma.prepLog.count({   where: nullRcWhere })) +
    (await prisma.salesEntry.count({ where: nullRcWhere })) +
    (await prisma.wastageLog.count({ where: nullRcWhere }))
  console.log(remaining === 0 ? '✓ no null-RC movements remain' : `✗ ${remaining} null-RC rows remain`)
  await prisma.$disconnect()
  process.exit(remaining === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
