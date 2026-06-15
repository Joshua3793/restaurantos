/** One-time: assign existing null-RC movements to the default revenue center. Idempotent. */
import { prisma } from '../src/lib/prisma'

async function main() {
  const def = await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true, name: true } })
  if (!def) throw new Error('No default revenue center found')
  console.log(`Default RC: ${def.name} (${def.id})`)

  const prep  = await prisma.prepLog.updateMany({   where: { revenueCenterId: null }, data: { revenueCenterId: def.id } })
  const sales = await prisma.salesEntry.updateMany({ where: { revenueCenterId: null }, data: { revenueCenterId: def.id } })
  const waste = await prisma.wastageLog.updateMany({ where: { revenueCenterId: null }, data: { revenueCenterId: def.id } })

  console.log(`Backfilled → PrepLog ${prep.count}, SalesEntry ${sales.count}, WastageLog ${waste.count}`)
  const remaining =
    (await prisma.prepLog.count({   where: { revenueCenterId: null } })) +
    (await prisma.salesEntry.count({ where: { revenueCenterId: null } })) +
    (await prisma.wastageLog.count({ where: { revenueCenterId: null } }))
  console.log(remaining === 0 ? '✓ no null-RC movements remain' : `✗ ${remaining} null-RC rows remain`)
  await prisma.$disconnect()
  process.exit(remaining === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
