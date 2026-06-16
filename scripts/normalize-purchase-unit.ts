/**
 * Normalize InventoryItem.purchaseUnit to the container-or-'each' invariant.
 *
 * A measurement unit (kg/lb/l/ml/oz/…) stored in purchaseUnit collides with the
 * weight/volume branch of convertCountQtyToBase — counting in that unit short-circuits
 * to the purchase branch and yields a wrong base quantity (e.g. Havarti "1 kg" → 3250 g
 * instead of 1000 g). purchaseUnitToken now maps such units to 'each'; this pass applies
 * that to stored data and, defensively, re-resolves countUOM if the change invalidated it.
 *
 * Dry-run by default. Set APPLY=1 to write. Idempotent. No pricing columns touched
 * (pricePerBaseUnit depends on packUOM/qtyUOM, never purchaseUnit) and stockOnHand is
 * a stored snapshot — so this changes only FUTURE count interpretation, never history.
 */
import { prisma } from '../src/lib/prisma'
import { purchaseUnitToken } from '../src/lib/uom'
import { resolveCountUom, getCountableUoms } from '../src/lib/count-uom'

const APPLY = process.env.APPLY === '1'

async function main() {
  const items = await prisma.inventoryItem.findMany({
    select: {
      id: true, itemName: true,
      baseUnit: true, purchaseUnit: true, qtyPerPurchaseUnit: true,
      qtyUOM: true, innerQty: true, packSize: true, packUOM: true, countUOM: true,
    },
  })

  const changes: string[] = []
  let puChanged = 0, cuChanged = 0

  for (const it of items) {
    const newPU = purchaseUnitToken(it.purchaseUnit)
    if (newPU === it.purchaseUnit) continue
    puChanged++

    // Re-resolve countUOM against the NEW purchase structure; only rewrite it when the
    // stored value is no longer a valid count option (don't disturb a still-valid choice).
    const dimsNew = {
      baseUnit: it.baseUnit ?? 'each',
      purchaseUnit: newPU,
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
    if (cuMoves) cuChanged++

    changes.push(
      `  ${it.itemName} (${it.id}): purchaseUnit "${it.purchaseUnit}" → "${newPU}"` +
      (cuMoves ? `,  countUOM "${storedCU}" → "${newCU}"` : `  (countUOM "${storedCU}" still valid)`),
    )

    if (APPLY) {
      await prisma.inventoryItem.update({
        where: { id: it.id },
        data: cuMoves ? { purchaseUnit: newPU, countUOM: newCU } : { purchaseUnit: newPU },
      })
    }
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'} — ${puChanged} purchaseUnit normalized, ${cuChanged} countUOM re-resolved`)
  changes.forEach(c => console.log(c))
  if (!APPLY && puChanged) console.log(`\nRe-run with APPLY=1 to write.`)
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
