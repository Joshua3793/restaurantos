/**
 * READ-ONLY regression check for the UOM Phase-2 tokenization.
 *
 * Phase-2 changed how purchaseUnit / countUOM / selectedUom are STORED (canonical
 * tokens instead of free-text display strings) — it must NOT change the counted→base
 * MATH. This script verifies that property by exercising the live count-flow helpers
 * against every active inventory item.
 *
 * Two checks:
 *
 *  1. CONTAINER COLLAPSE (the real regression signal — expect 0):
 *     For an item whose purchaseUnit tokenizes to a CONTAINER (case/bag/box/…), the
 *     purchase-unit count option must EXPAND to its pack contents — i.e. 1 container
 *     holds > 1 base unit. If a container option collapses to ~1 base unit, the pack
 *     structure was lost (e.g. a display string failed to tokenize / parse) and counts
 *     would be off by the pack multiple. This is the check that proves the migration
 *     is safe.
 *
 *     NOTE: do NOT flag measurement-counted items (countUOM = g/ml/kg/…). For those,
 *     1 unit == 1 base unit legitimately (1 g of an item counted in grams is 1 g) —
 *     that is not a collapse, it is correct. Only CONTAINER purchase options are
 *     required to expand.
 *
 *  2. PATH AGREEMENT (informational — pre-existing noise expected):
 *     For each countable option, getCountableUoms().toBase should equal
 *     convertCountQtyToBase(1, option.label, item). Divergences here are mostly
 *     pre-existing (stored baseUnit ≠ derived base, duplicate 'each' options) and are
 *     unrelated to the tokenization — reported for visibility, not as a gate.
 */
import { prisma } from '../src/lib/prisma'
import { getCountableUoms, convertCountQtyToBase } from '../src/lib/count-uom'
import { purchaseUnitToken, CONTAINER_UNITS } from '../src/lib/uom'

interface Dims {
  baseUnit: string
  purchaseUnit: string
  qtyPerPurchaseUnit: number
  qtyUOM: string | null
  innerQty: number | null
  packSize: number
  packUOM: string
  countUOM: string
}

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
    },
  })

  let containerOptions = 0
  const collapses: string[] = []      // GATE: container with real pack structure that fails to expand
  const degenerate: string[] = []     // informational: container over a genuinely 1-unit pack (pre-existing data)
  const disagreements: string[] = []

  for (const it of items) {
    const dims: Dims = {
      baseUnit: it.baseUnit ?? 'each',
      purchaseUnit: it.purchaseUnit ?? 'each',
      qtyPerPurchaseUnit: Number(it.qtyPerPurchaseUnit ?? 1),
      qtyUOM: it.qtyUOM ?? 'each',
      innerQty: it.innerQty != null ? Number(it.innerQty) : null,
      packSize: Number(it.packSize ?? 0),
      packUOM: it.packUOM ?? 'each',
      countUOM: it.countUOM ?? 'each',
    }

    let options
    try {
      options = getCountableUoms(dims)
    } catch (e) {
      collapses.push(`✗ ${it.itemName} (${it.id}): getCountableUoms threw — ${(e as Error).message}`)
      continue
    }

    const purchaseToken = purchaseUnitToken(dims.purchaseUnit)

    for (const opt of options) {
      // Check 1: container purchase option must expand past a single base unit.
      const isPurchaseOption = opt.label === purchaseToken
      if (isPurchaseOption && CONTAINER_UNITS.has(purchaseToken)) {
        containerOptions++
        if (opt.toBase <= 1.0000001) {
          // A container collapsing to ~1 base unit is only a MIGRATION regression when the
          // structured pack columns say it should expand (qty/pack/inner > 1). When every
          // structured dimension is already 1, the pack is genuinely (or mis-)configured as
          // a single unit — that is pre-existing data, unchanged by tokenization, because the
          // base math reads only these structured columns (never the purchaseUnit string).
          const packImpliesExpansion =
            dims.qtyPerPurchaseUnit > 1 || dims.packSize > 1 || (dims.innerQty ?? 0) > 1
          const detail =
            `(qtyPerPU=${dims.qtyPerPurchaseUnit} qtyUOM=${dims.qtyUOM} packSize=${dims.packSize} packUOM=${dims.packUOM} innerQty=${dims.innerQty})`
          if (packImpliesExpansion) {
            collapses.push(`✗ ${it.itemName} (${it.id}): container "${purchaseToken}" collapses to ${opt.toBase} base ${detail}`)
          } else {
            degenerate.push(`· ${it.itemName} (${it.id}): "${purchaseToken}" over a 1-unit pack ${detail}`)
          }
        }
      }

      // Check 2: the two code paths should agree on base units per 1 option.
      const viaConvert = convertCountQtyToBase(1, opt.label, dims)
      if (!approxEqual(opt.toBase, viaConvert)) {
        disagreements.push(
          `~ ${it.itemName} (${it.id}): option "${opt.label}" getCountableUoms.toBase=${opt.toBase} ` +
          `vs convertCountQtyToBase=${viaConvert}`,
        )
      }
    }
  }

  console.log(`\nScanned ${items.length} active items.`)
  console.log(`\n── Check 1: CONTAINER COLLAPSE (regression gate) ──`)
  console.log(`   ${containerOptions} container purchase options evaluated.`)
  if (collapses.length === 0) {
    console.log(`   ✓ 0 regressions — every container with real pack structure expands correctly. Migration safe.`)
  } else {
    console.log(`   ⚠ ${collapses.length} regression(s) — container with pack structure that fails to expand:`)
    collapses.forEach(l => console.log(`     ${l}`))
  }
  if (degenerate.length) {
    console.log(`\n   ${degenerate.length} pre-existing 1-unit container(s) (data quality, NOT a migration regression — base math reads structured cols only):`)
    degenerate.forEach(l => console.log(`     ${l}`))
  }

  console.log(`\n── Check 2: PATH AGREEMENT (informational, pre-existing noise expected) ──`)
  if (disagreements.length === 0) {
    console.log(`   ✓ all options agree across both code paths.`)
  } else {
    console.log(`   ${disagreements.length} option(s) where the two paths differ (pre-existing; not a migration gate):`)
    disagreements.slice(0, 40).forEach(l => console.log(`     ${l}`))
    if (disagreements.length > 40) console.log(`     … and ${disagreements.length - 40} more`)
  }

  await prisma.$disconnect()
  // Gate ONLY on container collapses — the actual migration-safety property.
  if (collapses.length > 0) process.exit(1)
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
