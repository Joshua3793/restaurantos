import { prisma } from '../src/lib/prisma'
import { formatPurchaseDisplay } from '../src/lib/count-uom'
let fail = 0
const check = (n: string, c: boolean, d = '') => { console.log(`${c?'✓':'✗'} ${n}${d?' — '+d:''}`); if(!c) fail++ }
async function main() {
  const coco = await prisma.inventoryItem.findFirst({ where: { itemName: { contains: 'coconut milk', mode: 'insensitive' } } })
  if (coco) {
    const d = formatPurchaseDisplay({ purchaseUnit: coco.purchaseUnit, qtyPerPurchaseUnit: Number(coco.qtyPerPurchaseUnit), innerQty: coco.innerQty != null ? Number(coco.innerQty) : null, packSize: Number(coco.packSize), packUOM: coco.packUOM, qtyUOM: coco.qtyUOM, baseUnit: coco.baseUnit, countUOM: coco.countUOM })
    check('coconut milk display derives from structured cols (12×400 ml / 4.8 l, not stale 6×2.84 l)', /400.*ml/.test(d) || /4\.8.*l/.test(d) || /12 ?×/.test(d), `got "${d}"`)
  } else check('coconut milk fixture present', false)
  await prisma.$disconnect(); process.exit(fail ? 1 : 0)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
