/** One-time: assign APPROVED invoice sessions with no RC to the default revenue center. Idempotent. */
import { prisma } from '../src/lib/prisma'

async function main() {
  const def = await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true, name: true } })
  if (!def) throw new Error('No default revenue center found')
  console.log(`Default RC: ${def.name} (${def.id})`)
  const res = await prisma.invoiceSession.updateMany({
    where: { status: 'APPROVED', revenueCenterId: null },
    data: { revenueCenterId: def.id },
  })
  console.log(`Backfilled ${res.count} approved sessions → ${def.name}`)
  const remaining = await prisma.invoiceSession.count({ where: { status: 'APPROVED', revenueCenterId: null } })
  console.log(remaining === 0 ? '✓ no null-RC approved sessions remain' : `✗ ${remaining} remain`)
  await prisma.$disconnect()
  process.exit(remaining === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
