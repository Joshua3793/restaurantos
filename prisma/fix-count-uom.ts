/**
 * One-time script: update countUOM for every InventoryItem where the stored
 * value is no longer valid given the item's purchase structure.
 *
 * Run with: npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/fix-count-uom.ts
 * Delete this file after running.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const UNIT_CONV: Record<string, number> = {
  g: 1, mg: 0.001, kg: 1000, lb: 453.592, oz: 28.3495,
  ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000,
  each: 1, ea: 1,
}
function getUnitConv(u: string): number { return UNIT_CONV[u?.toLowerCase()] ?? 1 }

function deriveBaseUnit(qtyUOM: string, packUOM: string): string {
  const weight = ['g','kg','lb','oz','mg']
  const volume = ['ml','l','cl','dl','fl oz']
  if (weight.includes(qtyUOM)) return 'g'
  if (volume.includes(qtyUOM)) return 'ml'
  if (weight.includes(packUOM)) return 'g'
  if (volume.includes(packUOM)) return 'ml'
  return 'each'
}

function getValidCountUoms(purchaseUnit: string, qtyPerPurchaseUnit: number, qtyUOM: string, innerQty: number | null, packSize: number, packUOM: string): string[] {
  const weight = ['g','kg','lb','oz','mg']
  const volume = ['ml','l','cl','dl','fl oz']
  const isWeightQty = weight.includes(qtyUOM) || volume.includes(qtyUOM)
  const base = deriveBaseUnit(qtyUOM, packUOM)
  const ps = packSize
  const pu = packUOM
  const hasItemWeight = (base === 'g' || base === 'ml') && ps > 0
  const uoms: string[] = []

  // Purchase unit always valid
  uoms.push(purchaseUnit)

  // Pack level (qtyUOM = pack)
  if (qtyUOM === 'pack' && innerQty != null && innerQty > 0) uoms.push('pack')

  // Each
  if (hasItemWeight) uoms.push('each')
  else if (qtyUOM === 'each' || qtyUOM === 'pack') uoms.push('each')

  // Weight/volume
  if (!isWeightQty) {
    if (base === 'g')  uoms.push('kg', 'g', 'lb')
    if (base === 'ml') uoms.push('l', 'ml')
  } else {
    if (weight.includes(qtyUOM)) uoms.push('kg', 'g', 'lb')
    if (volume.includes(qtyUOM)) uoms.push('l', 'ml')
  }

  return uoms
}

async function main() {
  const items = await prisma.inventoryItem.findMany({
    select: {
      id: true, itemName: true,
      purchaseUnit: true, qtyPerPurchaseUnit: true,
      qtyUOM: true, innerQty: true, packSize: true, packUOM: true,
      countUOM: true,
    },
  })

  let updated = 0
  let skipped = 0

  for (const item of items) {
    const qu  = item.qtyUOM ?? 'each'
    const iq  = item.innerQty != null ? Number(item.innerQty) : null
    const ps  = Number(item.packSize ?? 1)
    const pu  = item.packUOM ?? 'each'
    const qty = Number(item.qtyPerPurchaseUnit)
    const cu  = item.countUOM ?? 'each'

    const valid = getValidCountUoms(item.purchaseUnit, qty, qu, iq, ps, pu)
    if (valid.includes(cu)) { skipped++; continue }

    const newCountUOM = valid[0]
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { countUOM: newCountUOM } })
    console.log(`  FIXED  ${item.itemName}: "${cu}" → "${newCountUOM}"`)
    updated++
  }

  console.log(`\nDone. Fixed: ${updated} · Already valid: ${skipped}`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
