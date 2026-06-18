// Backfill InventorySupplierPrice offers from approved invoice history.
// Walks approved sessions oldest → newest so the final upsert per
// (item, supplier) is the most recent purchase. Idempotent.
// Run: set -a && . ./.env; set +a && \
//   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/backfill-supplier-offers.ts

import { prisma } from '../src/lib/prisma'
import { scanLinePricePerBase } from '../src/lib/supplier-offers'

async function main() {
  // Wipe first: the table is fully derivable from approved invoice history,
  // and stale rows keyed by OCR name variants ("… Inc." vs "… Inc. - Vancouver")
  // would otherwise survive canonicalization. isPrimary flags are reset —
  // acceptable; the feature just shipped.
  await prisma.inventorySupplierPrice.deleteMany({})

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
  // Canonical-name cache: Supplier.id → Supplier.name (avoids one query per session)
  const supplierNameCache = new Map<string, string>()
  for (const s of sessions) {
    // Canonicalize: key offers by the Supplier entity's name when the session
    // resolved one, so OCR name variants collapse onto a single offer row.
    let offerSupplierName = s.supplierName!
    if (s.supplierId) {
      let name = supplierNameCache.get(s.supplierId)
      if (name === undefined) {
        const sup = await prisma.supplier.findUnique({ where: { id: s.supplierId }, select: { name: true } })
        name = sup?.name ?? s.supplierName!
        supplierNameCache.set(s.supplierId, name)
      }
      offerSupplierName = name
    }
    for (const li of s.scanItems) {
      if (!li.matchedItemId || li.newPrice == null) continue
      // Skip unreliable per-case lines: without invoice pack data the fallback
      // to the ITEM's stored format produced wrong ppb (50× artifacts).
      // per_weight lines keep working off rate/rateUOM.
      if (li.pricingMode !== 'per_weight' && (li.invoicePackQty == null || li.invoicePackSize == null)) continue
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
        where: { inventoryItemId_supplierName: { inventoryItemId: li.matchedItemId, supplierName: offerSupplierName } },
        create: {
          inventoryItemId: li.matchedItemId,
          supplierName: offerSupplierName,
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
