// Backfill InventorySupplierPrice offers from approved invoice history.
// Walks approved sessions oldest → newest so the final upsert per
// (item, supplier) is the most recent purchase. Idempotent.
// Run: set -a && . ./.env; set +a && \
//   npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-supplier-offers.ts

import { prisma } from '../src/lib/prisma'
import { scanLinePricePerBase } from '../src/lib/supplier-offers'

async function main() {
  const sessions = await prisma.invoiceSession.findMany({
    where: { status: 'APPROVED', supplierName: { not: null } },
    orderBy: [{ approvedAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, supplierName: true, supplierId: true,
      scanItems: {
        where: { approved: true, matchedItemId: { not: null }, action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] } },
        select: {
          matchedItemId: true, newPrice: true, rawUnitPrice: true, rate: true, rateUOM: true, pricingMode: true,
          invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true, supplierItemCode: true,
        },
      },
    },
  })

  let upserts = 0
  for (const s of sessions) {
    for (const li of s.scanItems) {
      if (!li.matchedItemId || li.newPrice == null) continue
      const item = await prisma.inventoryItem.findUnique({
        where: { id: li.matchedItemId },
        select: { qtyPerPurchaseUnit: true, packSize: true, packUOM: true },
      })
      if (!item) continue
      const ppb = scanLinePricePerBase(li, item)
      if (ppb === null) continue
      // lastPrice denomination contract (matcher divides lastPrice by the
      // offer's own pack): per_weight → the rate; per_case → the case price
      // as printed (rawUnitPrice), falling back to newPrice.
      const lastPrice = li.pricingMode === 'per_weight' && li.rate != null
        ? Number(li.rate)
        : (li.rawUnitPrice != null ? Number(li.rawUnitPrice) : Number(li.newPrice))
      const pack = li.invoicePackQty !== null && li.invoicePackSize !== null
        ? { packQty: Number(li.invoicePackQty), packSize: Number(li.invoicePackSize), packUOM: li.invoicePackUOM ?? 'each' }
        : {}
      await prisma.inventorySupplierPrice.upsert({
        where: { inventoryItemId_supplierName: { inventoryItemId: li.matchedItemId, supplierName: s.supplierName! } },
        create: {
          inventoryItemId: li.matchedItemId,
          supplierName: s.supplierName!,
          supplierId: s.supplierId,
          lastPrice,
          pricePerBaseUnit: ppb,
          isPrimary: false,
          supplierItemCode: li.supplierItemCode,
          lastInvoiceSessionId: s.id,
          ...pack,
        },
        update: {
          lastPrice,
          pricePerBaseUnit: ppb,
          lastUpdated: new Date(),
          lastInvoiceSessionId: s.id,
          ...(s.supplierId ? { supplierId: s.supplierId } : {}),
          ...(li.supplierItemCode ? { supplierItemCode: li.supplierItemCode } : {}),
          ...pack,
        },
      })
      upserts++
    }
  }
  const total = await prisma.inventorySupplierPrice.count()
  const all = await prisma.inventorySupplierPrice.findMany({ select: { inventoryItemId: true } })
  const counts = new Map<string, number>()
  for (const o of all) counts.set(o.inventoryItemId, (counts.get(o.inventoryItemId) ?? 0) + 1)
  const multi = [...counts.values()].filter(c => c > 1).length
  console.log(`Backfill done: ${upserts} upserts · ${total} offers total · ${multi} items with 2+ suppliers`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
