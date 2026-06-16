/**
 * READ-ONLY root-cause categorization for the UOM normalization pass.
 * Buckets every count-flow anomaly by WHY it happens, so we fix causes not symptoms.
 */
import { prisma } from '../src/lib/prisma'
import { getCountableUoms, convertCountQtyToBase } from '../src/lib/count-uom'
import { purchaseUnitToken, CONTAINER_UNITS } from '../src/lib/uom'
import { deriveBaseUnit, isMeasuredUnit, getUnitConv } from '../src/lib/utils'

function approxEqual(a: number, b: number): boolean {
  if (a === b) return true
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9)
  return Math.abs(a - b) / denom < 1e-6
}

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true, itemName: true,
      baseUnit: true, purchaseUnit: true, qtyPerPurchaseUnit: true,
      qtyUOM: true, innerQty: true, packSize: true, packUOM: true, countUOM: true,
      pricePerBaseUnit: true,
    },
  })

  const degenerateContainers: any[] = []
  const baseUnitDivergence: any[] = []   // stored baseUnit ≠ deriveBaseUnit → weight/volume option math differs
  const eachAmbiguity: any[] = []        // duplicate/ambiguous 'each' option
  const otherDisagreement: any[] = []

  for (const it of items) {
    const dims = {
      baseUnit: it.baseUnit ?? 'each',
      purchaseUnit: it.purchaseUnit ?? 'each',
      qtyPerPurchaseUnit: Number(it.qtyPerPurchaseUnit ?? 1),
      qtyUOM: it.qtyUOM ?? 'each',
      innerQty: it.innerQty != null ? Number(it.innerQty) : null,
      packSize: Number(it.packSize ?? 0),
      packUOM: it.packUOM ?? 'each',
      countUOM: it.countUOM ?? 'each',
    }
    const purchaseToken = purchaseUnitToken(dims.purchaseUnit)
    const derivedBase = deriveBaseUnit(dims.qtyUOM, dims.packUOM)
    const storedBase = (it.baseUnit ?? '').toLowerCase()

    // degenerate containers
    if (CONTAINER_UNITS.has(purchaseToken)) {
      const packImpliesExpansion = dims.qtyPerPurchaseUnit > 1 || dims.packSize > 1 || (dims.innerQty ?? 0) > 1
      if (!packImpliesExpansion) {
        degenerateContainers.push({ ...it, purchaseToken, derivedBase, storedBase })
      }
    }

    let options
    try { options = getCountableUoms(dims) } catch { continue }

    let labelledDivergence = false
    let labelledEach = false
    for (const opt of options) {
      const viaConvert = convertCountQtyToBase(1, opt.label, dims)
      if (approxEqual(opt.toBase, viaConvert)) continue
      const isWeightOpt = isMeasuredUnit(opt.label)
      if (isWeightOpt && storedBase && storedBase !== derivedBase) {
        if (!labelledDivergence) { baseUnitDivergence.push({ ...it, purchaseToken, derivedBase, storedBase, sample: `${opt.label}: ${opt.toBase} vs ${viaConvert}` }); labelledDivergence = true }
      } else if (opt.label === 'each') {
        if (!labelledEach) { eachAmbiguity.push({ ...it, purchaseToken, derivedBase, storedBase, sample: `each: gCU=${opt.toBase} cCQTB=${viaConvert}` }); labelledEach = true }
      } else {
        otherDisagreement.push({ ...it, purchaseToken, sample: `${opt.label}: ${opt.toBase} vs ${viaConvert}` })
      }
    }
  }

  const show = (title: string, rows: any[]) => {
    console.log(`\n══ ${title} — ${rows.length} ══`)
    for (const r of rows) {
      console.log(`  ${r.itemName} (${r.id})`)
      console.log(`     purchaseUnit=${r.purchaseUnit}→${r.purchaseToken}  storedBase=${r.baseUnit}  derivedBase=${r.derivedBase}  qtyUOM=${r.qtyUOM}  qtyPerPU=${r.qtyPerPurchaseUnit}  packSize=${r.packSize}  packUOM=${r.packUOM}  innerQty=${r.innerQty}  countUOM=${r.countUOM}` + (r.sample ? `  [${r.sample}]` : ''))
    }
  }

  show('A. DEGENERATE CONTAINERS (purchaseUnit=container, pack holds 1)', degenerateContainers)
  show('B. BASE-UNIT DIVERGENCE (stored baseUnit ≠ derived → weight/vol option math differs)', baseUnitDivergence)
  show('C. EACH AMBIGUITY (purchase-each vs unit-each)', eachAmbiguity)
  show('D. OTHER DISAGREEMENTS', otherDisagreement)

  console.log(`\nTOTAL: A=${degenerateContainers.length} B=${baseUnitDivergence.length} C=${eachAmbiguity.length} D=${otherDisagreement.length}`)
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
