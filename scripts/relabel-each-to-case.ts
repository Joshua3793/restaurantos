/**
 * Relabel a curated set of items whose purchaseUnit='each' actually denotes a CASE
 * (qtyPerPurchaseUnit > 1 over a weighed/measured base). With purchaseUnit='each' the
 * count flow emits a duplicate 'each' option whose purchase branch multiplies by
 * qtyPerPurchaseUnit (e.g. Garlic Powder '1 each' → 6300 g = the whole case of 12).
 * Relabel to 'case' so the purchase option and the unit 'each' become distinct, correct
 * options. Re-resolve countUOM only where the change invalidated the stored value.
 *
 * Dry-run by default; APPLY=1 writes. Idempotent (skips items not at 'each').
 * No pricing column touched; stockOnHand is a stored snapshot → only future counts change.
 */
import { prisma } from '../src/lib/prisma'
import { resolveCountUom, getCountableUoms } from '../src/lib/count-uom'

const APPLY = process.env.APPLY === '1'

// Curated: purchaseUnit='each' + qtyPerPurchaseUnit>1 + base≠each (a mislabeled case).
const IDS = [
  'c332fd346c712464688a9bda', // Garlic Powder
  'c8f1c080c26ed45a3bfb09b0', // Sesame Oil
  'c504b6bb3690142078df755a', // Mustard Dijon
  'c048754435fd844a9a875e0b', // Tahini
  'cfc6167f00af24c0ea1820e2', // Cashews
  'cmnmloj1m001hhgf043ilmblq', // White Wine Cooking
  'cf644f72a64424d5984df632', // Vinegar apple cider
  'ccba1c5bc05fd4c70a489d02', // Onion green
  'ca42d96c051e74f4ab38b92c', // Grapes
]

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: IDS } },
    select: {
      id: true, itemName: true,
      baseUnit: true, purchaseUnit: true, qtyPerPurchaseUnit: true,
      qtyUOM: true, innerQty: true, packSize: true, packUOM: true, countUOM: true,
    },
  })

  let changed = 0
  for (const it of items) {
    if (it.purchaseUnit !== 'each') { console.log(`  · ${it.itemName}: purchaseUnit="${it.purchaseUnit}" (not 'each') — skipped`); continue }
    changed++
    const dimsNew = {
      baseUnit: it.baseUnit ?? 'each',
      purchaseUnit: 'case',
      qtyPerPurchaseUnit: Number(it.qtyPerPurchaseUnit ?? 1),
      qtyUOM: it.qtyUOM ?? 'each',
      innerQty: it.innerQty != null ? Number(it.innerQty) : null,
      packSize: Number(it.packSize ?? 0),
      packUOM: it.packUOM ?? 'each',
      countUOM: it.countUOM ?? 'each',
    }
    const validLabels = getCountableUoms(dimsNew).map(u => u.label)
    const storedCU = it.countUOM ?? 'each'
    const newCU = validLabels.includes(storedCU) ? storedCU : resolveCountUom(dimsNew)
    const cuMoves = newCU !== storedCU
    console.log(`  ${it.itemName}: purchaseUnit "each" → "case"` + (cuMoves ? `,  countUOM "${storedCU}" → "${newCU}"` : `  (countUOM "${storedCU}" still valid)`))
    if (APPLY) {
      await prisma.inventoryItem.update({
        where: { id: it.id },
        data: cuMoves ? { purchaseUnit: 'case', countUOM: newCU } : { purchaseUnit: 'case' },
      })
    }
  }
  console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'} — ${changed}/${IDS.length} relabeled`)
  if (!APPLY && changed) console.log('Re-run with APPLY=1 to write.')
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
