/** Idempotent: rewrite purchaseUnit/countUOM/selectedUom display strings to canonical
 * tokens via purchaseUnitToken. Numeric pack columns are authoritative and untouched. */
import { prisma } from '../src/lib/prisma'
import { purchaseUnitToken } from '../src/lib/uom'

async function main() {
  const items = await prisma.inventoryItem.findMany({ select: { id: true, purchaseUnit: true, countUOM: true } })
  let pu = 0, cu = 0
  for (const it of items) {
    const pt = purchaseUnitToken(it.purchaseUnit)
    if (pt !== it.purchaseUnit) { await prisma.inventoryItem.update({ where: { id: it.id }, data: { purchaseUnit: pt } }); pu++ }
    const ct = purchaseUnitToken(it.countUOM)
    if (ct !== it.countUOM) { await prisma.inventoryItem.update({ where: { id: it.id }, data: { countUOM: ct } }); cu++ }
  }
  console.log(`purchaseUnit: ${pu} tokenized, countUOM: ${cu} tokenized`)

  const lines = await prisma.countLine.findMany({ select: { id: true, selectedUom: true } })
  let s = 0
  for (const l of lines) {
    const t = purchaseUnitToken(l.selectedUom)
    if (t !== l.selectedUom) { await prisma.countLine.update({ where: { id: l.id }, data: { selectedUom: t } }); s++ }
  }
  console.log(`selectedUom: ${s} tokenized`)
  console.log('Done (idempotent).')
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
