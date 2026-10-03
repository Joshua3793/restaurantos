// READ-ONLY (findMany only). Reports how far the retired copies —
// InventoryItem.purchasePrice, InventoryItem.supplierId and
// InventorySupplierPrice.lastPrice — had drifted from what the app now derives
// (item headline price from its chain, box price from its pricing, item supplier
// from its primary box). The output is the owner's Before / After.
//
// Run: npx tsx scripts/verify-stale-column-parity.ts
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT } from '../src/lib/item-model'
import { listedPrice } from '../src/lib/cost-basis'
import { offerListedPrice } from '../src/lib/offer-price'
import { PRIMARY_SUPPLIER_INCLUDE } from '../src/lib/item-supplier'

const money = (n: number) => `$${n.toFixed(2)}`

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      itemName: true,
      purchasePrice: true,
      supplierId: true,
      supplier: { select: { name: true } },
      ...PRICING_SELECT,
      ...PRIMARY_SUPPLIER_INCLUDE,
    },
  })
  console.log(`Active items checked: ${items.length}`)

  // A: item headline price
  console.log('\nA. Item headline price — column vs derived')
  const aGaps = items
    .map((it) => {
      const col = Number(it.purchasePrice)
      const der = listedPrice(it as Parameters<typeof listedPrice>[0])
      return { name: it.itemName, col, der, gap: Math.abs(col - der), sup: it.supplierPrices[0]?.supplier.name ?? 'none' }
    })
    .filter((r) => r.gap > 0.01)
    .sort((x, y) => y.gap - x.gap)
  console.log(`  ${aGaps.length} items differ by more than $0.01. Largest 10:`)
  for (const r of aGaps.slice(0, 10)) {
    console.log(`  ${r.name}  column ${money(r.col)} → now ${money(r.der)}  (main supplier: ${r.sup})`)
  }

  // B: box price
  console.log('\nB. Box price — column vs derived')
  const offers = await prisma.inventorySupplierPrice.findMany({
    select: {
      id: true,
      lastPrice: true,
      pricing: true,
      inventoryItem: { select: { itemName: true } },
      supplier: { select: { name: true } },
    },
  })
  const bGaps = offers
    .map((o) => ({ o, col: Number(o.lastPrice), der: offerListedPrice(o) }))
    .filter((r) => Math.abs(r.col - r.der) > 0.01)
    .sort((x, y) => Math.abs(y.col - y.der) - Math.abs(x.col - x.der))
  console.log(`  ${bGaps.length} of ${offers.length} boxes differ by more than $0.01.`)
  for (const r of bGaps.slice(0, 10)) {
    console.log(`  ${r.o.inventoryItem.itemName} (${r.o.supplier.name})  column ${money(r.col)} → now ${money(r.der)}`)
  }

  // C: item supplier
  console.log('\nC. Item supplier — column vs main box')
  const rows = items.map((it) => ({
    name: it.itemName,
    colName: it.supplier?.name ?? null,
    derName: it.supplierPrices[0]?.supplier.name ?? null,
  }))
  const differ = rows.filter((r) => r.colName && r.derName && r.colName !== r.derName)
  const gained = rows.filter((r) => !r.colName && r.derName)
  const lost = rows.filter((r) => r.colName && !r.derName)
  const neither = rows.filter((r) => !r.colName && !r.derName)
  console.log(`  ${differ.length} items where the label and the main box disagree:`)
  for (const r of differ) console.log(`  ${r.name}  label ${r.colName} → now ${r.derName}`)
  console.log(`  ${gained.length} items had a main box but no supplier label (now show one)`)
  console.log(`  ${lost.length} items had a supplier label but no main box${lost.length ? ':' : ''}`)
  for (const r of lost) console.log(`  ${r.name}  label ${r.colName} → now none`)
  console.log(`  ${neither.length} items have neither`)

  console.log(
    `\nA: ${aGaps.length} items' headline price changes · B: ${bGaps.length} boxes · C: ${differ.length} supplier changes, ${gained.length} gained, ${lost.length} lost`,
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
