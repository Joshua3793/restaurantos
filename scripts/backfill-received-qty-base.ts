/**
 * Freeze InvoiceScanItem.receivedQtyBase for every approved line.
 *
 *   npx tsx scripts/backfill-received-qty-base.ts            # DRY RUN: writes a diff file, changes nothing
 *   npx tsx scripts/backfill-received-qty-base.ts --apply    # backup JSON first, then write
 *
 * "old" = today's rule (the item's own chain). "next" = the supplier-offer rule.
 * Every line where they differ is a historical miscount the dry run surfaces.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem } from '../src/lib/item-model'
import { lineReceivedBaseUnits } from '../src/lib/invoice/line-qty'
import { resolveLineFormat, pickOffer } from '../src/lib/invoice/line-format'

const APPLY = process.argv.includes('--apply')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

async function main() {
  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      approved: true,
      matchedItemId: { not: null },
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] },
      session: { status: 'APPROVED' },
    },
    select: {
      id: true,
      rawDescription: true,
      receivedQtyBase: true,
      rawQty: true,
      rawUnit: true,
      totalQty: true,
      totalQtyUOM: true,
      rateUOM: true,
      invoicePackQty: true,
      invoicePackSize: true,
      invoicePackUOM: true,
      rawUnitPrice: true,
      rate: true,
      rawLineTotal: true,
      session: {
        select: {
          supplierId: true,
          supplierName: true,
          invoiceNumber: true,
          purchaseDate: true,
          supplier: { select: { name: true } },
        },
      },
      matchedItem: {
        select: {
          id: true,
          itemName: true,
          ...PRICING_SELECT,
          supplierPrices: {
            select: { supplierId: true, supplierName: true, packChain: true, pricing: true },
          },
        },
      },
    },
  })

  const diff: unknown[] = []
  const writes: { id: string; next: number; prev: string | null }[] = []
  for (const l of lines) {
    if (!l.matchedItem) continue
    const input = {
      rawQty: l.rawQty?.toString() ?? null,
      rawUnit: l.rawUnit,
      totalQty: l.totalQty?.toString() ?? null,
      totalQtyUOM: l.totalQtyUOM,
      rateUOM: l.rateUOM,
      invoicePackQty: l.invoicePackQty?.toString() ?? null,
      invoicePackSize: l.invoicePackSize?.toString() ?? null,
      invoicePackUOM: l.invoicePackUOM,
      rawUnitPrice: l.rawUnitPrice?.toString() ?? null,
      rate: l.rate?.toString() ?? null,
      rawLineTotal: l.rawLineTotal?.toString() ?? null,
    }
    const chain = asChainItem(l.matchedItem)
    const old = lineReceivedBaseUnits(input, chain)
    const next = lineReceivedBaseUnits(
      input,
      resolveLineFormat(
        chain,
        pickOffer(l.matchedItem.supplierPrices, {
          supplierId: l.session.supplierId,
          supplierName: l.session.supplierName,
          canonicalName: l.session.supplier?.name ?? null,
        }),
      ),
    )
    if (Math.abs(next - old) > Math.max(0.001, old * 0.005)) {
      diff.push({
        item: l.matchedItem.itemName,
        base: l.matchedItem.baseUnit,
        line: l.rawDescription,
        supplier: l.session.supplierName,
        invoice: l.session.invoiceNumber,
        date: l.session.purchaseDate,
        old,
        next,
        ratio: old > 0 ? +(next / old).toFixed(3) : null,
      })
    }
    if (next > 0) writes.push({ id: l.id, next, prev: l.receivedQtyBase?.toString() ?? null })
  }

  writeFileSync(`received-qty-base-diff-${stamp}.json`, JSON.stringify(diff, null, 2))
  console.log(
    `${lines.length} approved lines · ${writes.length} to freeze · ${diff.length} change vs today's rule`,
  )
  console.log(`diff → received-qty-base-diff-${stamp}.json`)
  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --apply.')
    return
  }

  writeFileSync(
    `received-qty-base-backup-${stamp}.json`,
    JSON.stringify(
      writes.map((w) => ({ id: w.id, prev: w.prev })),
      null,
      2,
    ),
  )
  for (const w of writes) {
    await prisma.invoiceScanItem.update({ where: { id: w.id }, data: { receivedQtyBase: w.next } })
  }
  console.log(`applied ${writes.length} · backup → received-qty-base-backup-${stamp}.json`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
