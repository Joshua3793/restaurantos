// HARD-GATE equivalence verifier for the count + purchase conversion migration.
//
// For every InventoryItem, compute base-units-per-1-of-unit BOTH ways:
//   • LEGACY: an inline copy of the pre-change `convertCountQtyToBase` (reads the
//     legacy pack columns qtyUOM/packSize/packUOM/innerQty/qtyPerPurchaseUnit).
//   • NEW:    `convertCountQtyToBase(1, unit, chainDims)` (resolves via packChain).
// over a representative set of units (the legacy getCountableUoms labels + the
// chain level names). They MUST agree within max(1e-6, 0.0001×legacy).
//
// Run:
//   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-count-chain-equiv.ts
import { prisma } from '../src/lib/prisma'
import { convertCountQtyToBase } from '../src/lib/count-uom'
import { convertQty } from '../src/lib/uom'
import { getUnitConv, isMeasuredUnit, deriveBaseUnit } from '../src/lib/utils'
import { levelBaseUnits, type PackLink } from '../src/lib/item-model'

// ── inline copy of the PRE-CHANGE convertCountQtyToBase logic ──────────────────
interface LegacyDims {
  baseUnit: string
  purchaseUnit: string
  qtyPerPurchaseUnit: number
  qtyUOM?: string | null
  innerQty?: number | null
  packSize: number
  packUOM: string
}
function legacyConvertToBase(qty: number, selectedUom: string, item: LegacyDims): number {
  const sel = selectedUom.toLowerCase()
  const base = item.baseUnit.toLowerCase()
  if (sel === base) return qty

  const qtyUOM = (item.qtyUOM ?? 'each').toLowerCase()
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null

  const isWeightQty = isMeasuredUnit(qtyUOM)

  const itemBaseUnits = ps * getUnitConv(pu)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  // Purchase unit
  if (sel === item.purchaseUnit.toLowerCase()) {
    const qtyNum = Number(item.qtyPerPurchaseUnit)
    if (isWeightQty) return qty * qtyNum * getUnitConv(qtyUOM)
    if (qtyUOM === 'pack' && innerQty != null) return qty * qtyNum * packBaseUnits
    return qty * qtyNum * (itemBaseUnits > 0 ? itemBaseUnits : 1)
  }
  // Pack level
  if (sel === 'pack' && qtyUOM === 'pack' && innerQty != null) {
    return qty * packBaseUnits
  }
  // Each
  if (sel === 'each') {
    return itemBaseUnits > 0 ? qty * itemBaseUnits : qty
  }
  // Standard weight/volume conversion
  return convertQty(qty, selectedUom, item.baseUnit)
}

// ── inline copy of the PRE-CHANGE getCountableUoms label set ───────────────────
// `chainHasEachLevel` / `dimension` let us scope the legacy `each` label: for a
// MASS/VOLUME item whose chain collapsed to a single (case) level, the legacy
// `each` derived from the now-dropped per-piece `packSize` — which conflicted
// with the measured `qtyUOM` case calc (internally inconsistent legacy data).
// The new model offers no bare `each` for those, so we don't assert on it.
function legacyCountUomLabels(
  item: LegacyDims,
  opts: { dimension: string; chainHasEachLevel: boolean },
): string[] {
  const labels: string[] = []
  const qtyUOM = item.qtyUOM ?? 'each'
  const base = deriveBaseUnit(qtyUOM, item.packUOM ?? 'each')
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null
  const hasInnerQty = innerQty != null && innerQty > 0
  const ps = Number(item.packSize ?? 0)
  const hasWeight = base === 'g' || base === 'ml'
  const hasItemWeight = hasWeight && ps > 0

  labels.push(item.purchaseUnit)
  if (qtyUOM === 'pack' && hasInnerQty) labels.push('pack')
  // `each` is well-defined for COUNT items (=base) and for measured items whose
  // chain preserved an `each` level. A measured single-level chain dropped its
  // (inconsistent) per-piece weight → skip.
  const eachComparable = opts.dimension === 'COUNT' || opts.chainHasEachLevel
  if ((hasItemWeight || qtyUOM === 'each' || qtyUOM === 'pack') && eachComparable) labels.push('each')
  if (base === 'g' && hasItemWeight) labels.push('kg', 'lb', 'g')
  if (base === 'ml' && hasItemWeight) labels.push('l', 'ml')
  return labels
}

async function main() {
  const items = await prisma.inventoryItem.findMany({
    select: {
      id: true, itemName: true, baseUnit: true,
      qtyUOM: true, packSize: true, packUOM: true, innerQty: true,
      qtyPerPurchaseUnit: true, purchaseUnit: true, countUOM: true,
      dimension: true, packChain: true, pricing: true, countUnit: true,
    },
  })

  let unitChecks = 0
  const diffs: { item: string; unit: string; legacy: number; next: number }[] = []

  for (const it of items) {
    const legacyDims: LegacyDims = {
      baseUnit: it.baseUnit,
      purchaseUnit: it.purchaseUnit,
      qtyPerPurchaseUnit: Number(it.qtyPerPurchaseUnit),
      qtyUOM: it.qtyUOM ?? 'each',
      innerQty: it.innerQty != null ? Number(it.innerQty) : null,
      packSize: Number(it.packSize ?? 0),
      packUOM: it.packUOM ?? 'each',
    }
    const chainDims = {
      dimension: it.dimension,
      baseUnit: it.baseUnit,
      packChain: it.packChain,
      countUnit: it.countUnit,
    }

    const chainLevelNames = Object.keys(levelBaseUnits((it.packChain as PackLink[]) ?? []))
    const chainHasEachLevel = chainLevelNames.some(u => u.toLowerCase() === 'each')
    const units = Array.from(new Set([
      ...legacyCountUomLabels(legacyDims, { dimension: it.dimension, chainHasEachLevel }),
      it.baseUnit,
      ...chainLevelNames,
    ]))

    for (const unit of units) {
      const legacy = legacyConvertToBase(1, unit, legacyDims)
      const next = convertCountQtyToBase(1, unit, chainDims)
      unitChecks++
      const tol = Math.max(1e-6, 0.0001 * Math.abs(legacy))
      if (Math.abs(legacy - next) > tol) {
        diffs.push({ item: it.itemName, unit, legacy, next })
      }
    }
  }

  if (diffs.length === 0) {
    console.log(`OK — ${items.length} items, ${unitChecks} unit-checks, 0 diffs`)
  } else {
    console.log(`FAIL — ${items.length} items, ${unitChecks} unit-checks, ${diffs.length} diffs:`)
    for (const d of diffs) {
      console.log(`  ${d.item}  [${d.unit}]  legacy=${d.legacy}  new=${d.next}`)
    }
  }

  await prisma.$disconnect()
  process.exit(diffs.length === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
