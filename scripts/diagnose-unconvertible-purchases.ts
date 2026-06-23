/**
 * Root-cause leak #2: matched+stocked purchase lines that credit ZERO base units.
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/diagnose-unconvertible-purchases.ts
 *
 * Replicates buildPurchaseMap's per-line conversion and prints, for each line that
 * resolves to 0, the item chain + line fields + which branch failed and why.
 */
import { prisma } from '../src/lib/prisma'
import { convertQty, UNIT_FACTORS, canonicalUom } from '../src/lib/uom'
import { asChainItem, basePerUnit, dimensionOf, PRICING_SELECT } from '../src/lib/item-model'

async function main() {
  const scanItems = await prisma.invoiceScanItem.findMany({
    where: {
      session: { status: 'APPROVED', parentSessionId: null },
      approved: true, splitToSessionId: null,
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
      matchedItemId: { not: null }, rawQty: { not: null },
    },
    select: {
      rawDescription: true, rawQty: true, rawUnit: true, totalQty: true, totalQtyUOM: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true, pricingMode: true,
      matchedItemId: true,
      matchedItem: { select: { id: true, itemName: true, ...PRICING_SELECT } },
    },
  })

  let zeroCount = 0
  const byReason = new Map<string, number>()
  for (const si of scanItems) {
    if (!si.matchedItem) continue
    const chainItem = asChainItem(si.matchedItem)
    const baseUnit = chainItem.baseUnit
    const qty = Number(si.rawQty ?? 0)
    if (qty <= 0) continue

    const isRate = chainItem.pricing.mode === 'RATE'
    let baseUnits = 0, branch = '', reason = ''
    let billedQty = qty, billedUOM: string | null = null
    if (isRate) {
      if (si.totalQty != null && Number(si.totalQty) > 0) { billedQty = Number(si.totalQty); billedUOM = si.totalQtyUOM ?? baseUnit }
      else { billedQty = qty; billedUOM = si.rawUnit ?? baseUnit }
    }
    if (isRate && billedUOM && UNIT_FACTORS[canonicalUom(billedUOM)]) {
      branch = 'RATE/convert'
      baseUnits = convertQty(billedQty, billedUOM, baseUnit)
      if (baseUnits === 0) reason = `convertQty(${billedQty} ${billedUOM} -> ${baseUnit}) = 0 (dim ${dimensionOf(billedUOM)} vs ${chainItem.dimension})`
    } else {
      const packQty = si.invoicePackQty ? Number(si.invoicePackQty) : 0
      const packSize = si.invoicePackSize ? Number(si.invoicePackSize) : 0
      const packUOM = si.invoicePackUOM ?? null
      if (packQty > 0 && packSize > 0 && packUOM) {
        branch = 'pack-format'
        baseUnits = convertQty(qty * packQty * packSize, packUOM, baseUnit)
        if (baseUnits === 0) reason = `convertQty(${qty}*${packQty}*${packSize} ${packUOM} -> ${baseUnit}) = 0 (dim ${dimensionOf(packUOM)} vs ${chainItem.dimension})`
      } else {
        branch = 'chain-fallback'
        const top = chainItem.packChain[0]?.unit
        const perCase = top ? basePerUnit(chainItem, top) : 1
        baseUnits = qty * perCase
        if (baseUnits === 0) reason = `perCase=0 (top='${top}', chain=${JSON.stringify(chainItem.packChain)})`
      }
    }

    if (baseUnits === 0) {
      zeroCount++
      byReason.set(branch, (byReason.get(branch) ?? 0) + 1)
      if (zeroCount <= 20) {
        console.log(`ZERO: ${si.matchedItem.itemName.padEnd(24).slice(0,24)} [${chainItem.dimension}/${baseUnit}] chain=${JSON.stringify(chainItem.packChain).slice(0,40)}`)
        console.log(`      line: ${qty} ${si.rawUnit ?? ''} pack=${si.invoicePackQty}x${si.invoicePackSize}${si.invoicePackUOM ?? ''} mode=${si.pricingMode} | branch=${branch}`)
        console.log(`      WHY: ${reason}`)
      }
    }
  }
  console.log(`\nTotal zero-credit lines: ${zeroCount}`)
  console.log(`By branch:`, Object.fromEntries(byReason))
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
