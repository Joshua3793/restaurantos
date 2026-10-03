// Before the item's own `supplierId` column is retired, every item that names a
// supplier gets a supplier BOX from its own chain + price (same numbers, nothing
// re-priced), so the derived supplier (primary box) equals what the item showed.
//   DRY RUN (default):  npx tsx scripts/backfill-item-supplier-boxes.ts
//   APPLY:              npx tsx scripts/backfill-item-supplier-boxes.ts --apply
// Also copies a single-valued legacy `location` onto an empty storageAreaId.
import fs from 'fs'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT } from '../src/lib/item-model'
import { listedPrice } from '../src/lib/cost-basis'

const APPLY = process.argv.includes('--apply')

async function main() {
  const areas = await prisma.storageArea.findMany({ select: { id: true, name: true } })
  const areaByName = new Map(areas.map(a => [a.name.trim().toLowerCase(), a.id]))

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true, itemName: true, supplierId: true, storageAreaId: true, location: true, ...PRICING_SELECT,
      supplier: { select: { id: true, name: true } },
      supplierPrices: { select: { id: true, supplierId: true, isPrimary: true } },
    },
  })

  const boxes: { itemId: string; label: string; data: Record<string, unknown> }[] = []
  const areasToSet: { itemId: string; label: string; storageAreaId: string }[] = []
  const differs: string[] = []

  for (const it of items) {
    if (it.supplierId && it.supplier && it.supplierPrices.length === 0) {
      const price = listedPrice(it)
      boxes.push({
        itemId: it.id,
        label: `${it.itemName}: box for ${it.supplier.name} at ${price.toFixed(2)} (${(it.pricing as { mode?: string })?.mode ?? 'PACK'})`,
        data: {
          inventoryItemId: it.id, supplierId: it.supplierId, supplierName: it.supplier.name,
          isPrimary: true, lastPrice: price, packChain: it.packChain as object, pricing: it.pricing as object,
          packQty: null, packSize: null, packUOM: null, supplierItemCode: null,
        },
      })
    }
    const primary = it.supplierPrices.find(o => o.isPrimary)
    if (it.supplierId && primary && primary.supplierId !== it.supplierId) differs.push(`${it.itemName}: item says ${it.supplier?.name}, primary box is another supplier — the box wins`)
    if (!it.storageAreaId && it.location) {
      const id = areaByName.get(it.location.trim().toLowerCase())
      if (id) areasToSet.push({ itemId: it.id, label: `${it.itemName}: location "${it.location}" → storage area`, storageAreaId: id })
    }
  }

  console.log(`Supplier boxes to create: ${boxes.length}`)
  for (const b of boxes) console.log(`  ${APPLY ? 'APPLY' : 'DRY  '} ${b.label}`)
  console.log(`Storage areas to set from a single-valued location: ${areasToSet.length}`)
  for (const a of areasToSet) console.log(`  ${APPLY ? 'APPLY' : 'DRY  '} ${a.label}`)
  console.log(`Items whose own supplier differs from their primary box (information only, no write): ${differs.length}`)
  for (const d of differs) console.log(`  ${d}`)
  if (!APPLY || (boxes.length === 0 && areasToSet.length === 0)) { console.log(APPLY ? 'nothing to write' : 're-run with --apply to write'); return }

  const backup = `item-supplier-boxes-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  fs.writeFileSync(backup, JSON.stringify({ boxes, areasToSet }, null, 2))
  console.log(`backup written: ${backup}`)
  await prisma.$transaction([
    ...boxes.map(b => prisma.inventorySupplierPrice.create({ data: b.data as Parameters<typeof prisma.inventorySupplierPrice.create>[0]['data'] })),
    ...areasToSet.map(a => prisma.inventoryItem.update({ where: { id: a.itemId }, data: { storageAreaId: a.storageAreaId } })),
  ])
  console.log(`${boxes.length} box(es) created, ${areasToSet.length} storage area(s) set`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
