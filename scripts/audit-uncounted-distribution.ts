/** READ-ONLY: distribution of stockOnHand among never-counted items. */
import { prisma } from '../src/lib/prisma'

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, isStocked: true, lastCountDate: null },
    select: { id: true, itemName: true, baseUnit: true, stockOnHand: true },
  })
  const zero = items.filter(i => Number(i.stockOnHand) === 0)
  const nonzero = items.filter(i => Number(i.stockOnHand) !== 0)

  console.log(`Never-counted active+stocked items: ${items.length}`)
  console.log(`  • stockOnHand == 0  (presume-0 is SAFE): ${zero.length}`)
  console.log(`  • stockOnHand  > 0  (presume-0 ERASES opening balance): ${nonzero.length}`)

  console.log('\nNon-zero opening balances at risk if we force 0:')
  console.log(['Item', 'stockOnHand', 'unit'].join('\t'))
  for (const i of nonzero.sort((a, b) => Number(b.stockOnHand) - Number(a.stockOnHand))) {
    console.log([i.itemName.slice(0, 34), Number(i.stockOnHand).toLocaleString('en-US'), i.baseUnit].join('\t'))
  }
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
