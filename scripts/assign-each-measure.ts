// List/apply count↔weight bridges. Run:
//   npx tsx scripts/assign-each-measure.ts --list
//   npx tsx scripts/assign-each-measure.ts --apply
import { prisma } from '../src/lib/prisma'

// Confirmed bridges go here after reviewing --list output:
const ASSIGN: { itemId: string; qty: number; unit: string }[] = [
  // { itemId: 'ckxxx', qty: 1100, unit: 'g' },
]

async function list() {
  const items = await prisma.inventoryItem.findMany({
    where: { dimension: 'COUNT' },
    select: {
      id: true,
      itemName: true,
      baseUnit: true,
      eachMeasureQty: true,
      eachMeasureUnit: true,
      supplierPrices: { select: { supplierName: true, packUOM: true, packSize: true } },
      matchRules: { select: { invoicePackUOM: true, invoicePackSize: true } },
    },
  })

  const measured = (u?: string | null) =>
    !!u && ['g', 'kg', 'ml', 'l', 'oz', 'lb'].includes(u.toLowerCase())

  const candidates = items.filter(
    i =>
      i.supplierPrices.some(p => measured(p.packUOM)) ||
      i.matchRules.some(r => measured(r.invoicePackUOM)),
  )

  for (const c of candidates) {
    const sizes = [
      ...c.supplierPrices
        .filter(p => measured(p.packUOM))
        .map(p => `${p.supplierName}:${p.packSize}${p.packUOM}`),
      ...c.matchRules
        .filter(r => measured(r.invoicePackUOM))
        .map(r => `rule:${r.invoicePackSize}${r.invoicePackUOM}`),
    ]
    const bridge =
      c.eachMeasureQty != null
        ? ` [bridge: ${c.eachMeasureQty}${c.eachMeasureUnit}]`
        : ' [no bridge]'
    console.log(`${c.id}  ${c.itemName}${bridge}  → ${sizes.join(', ')}`)
  }

  console.log(
    `\n${candidates.length} candidate COUNT item(s). Add confirmed ones to ASSIGN and run --apply.`,
  )
}

async function apply() {
  if (ASSIGN.length === 0) {
    console.log('ASSIGN is empty — nothing to apply.')
    return
  }
  for (const a of ASSIGN) {
    await prisma.inventoryItem.update({
      where: { id: a.itemId },
      data: { eachMeasureQty: a.qty, eachMeasureUnit: a.unit },
    })
    console.log(`✓ ${a.itemId} → 1 each = ${a.qty} ${a.unit}`)
  }
  console.log(`\napplied ${ASSIGN.length} bridge(s)`)
}

const mode = process.argv[2]
;(mode === '--apply' ? apply() : list())
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
