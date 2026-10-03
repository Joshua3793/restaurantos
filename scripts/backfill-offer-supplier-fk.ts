// Make every supplier box link to its supplier before the column becomes NOT NULL.
//   DRY RUN (default, writes nothing):   npx tsx scripts/backfill-offer-supplier-fk.ts
//   APPLY (writes exactly the dry-run rows, backup JSON first):  … --apply
// Only three kinds of write, all listed by the dry run first:
//   1. offer.supplierId  null → the proposed supplier (exact alias/name, else fuzzy ≥ 0.5)
//   2. offer.supplierName     → the linked Supplier.name when they differ (display only)
//   3. APPROVED session.supplierId null → the proposed supplier
// An UNRESOLVED row is printed and left alone; the migration in Task 3 will then
// refuse to run, which is the point.
import fs from 'fs'
import { prisma } from '../src/lib/prisma'
import { proposeSupplier } from '../src/lib/supplier-propose'

const APPLY = process.argv.includes('--apply')

async function main() {
  const plan: { kind: 'offer-link' | 'offer-name' | 'session-link'; id: string; before: unknown; after: unknown; label: string }[] = []

  // supplierId is NOT NULL now: raw SQL keeps this section a valid regression check.
  const unlinked = await prisma.$queryRawUnsafe<{ id: string; supplierName: string; itemName: string }[]>(
    `SELECT o.id, o."supplierName", i."itemName" FROM "InventorySupplierPrice" o JOIN "InventoryItem" i ON i.id = o."inventoryItemId" WHERE o."supplierId" IS NULL`)
  for (const o of unlinked) {
    const p = await proposeSupplier(o.supplierName)
    if (!p) { console.log(`UNRESOLVED offer ${o.id} ${o.itemName} "${o.supplierName}"`); continue }
    plan.push({ kind: 'offer-link', id: o.id, before: { supplierId: null, supplierName: o.supplierName }, after: { supplierId: p.id, supplierName: p.name }, label: `${o.itemName}: "${o.supplierName}" → ${p.name} (${p.how})` })
  }
  for (const o of await prisma.inventorySupplierPrice.findMany({ select: { id: true, supplierName: true, supplier: { select: { name: true } }, inventoryItem: { select: { itemName: true } } } })) {
    if (o.supplierName !== o.supplier.name)
      plan.push({ kind: 'offer-name', id: o.id, before: { supplierName: o.supplierName }, after: { supplierName: o.supplier.name }, label: `${o.inventoryItem.itemName}: "${o.supplierName}" → "${o.supplier.name}"` })
  }
  for (const s of await prisma.invoiceSession.findMany({ where: { supplierId: null, status: 'APPROVED' }, select: { id: true, supplierName: true, invoiceNumber: true } })) {
    const p = s.supplierName ? await proposeSupplier(s.supplierName) : null
    if (!p) { console.log(`UNRESOLVED session ${s.id} "${s.supplierName}"`); continue }
    plan.push({ kind: 'session-link', id: s.id, before: { supplierId: null }, after: { supplierId: p.id }, label: `invoice #${s.invoiceNumber ?? '—'} "${s.supplierName}" → ${p.name} (${p.how})` })
  }

  for (const w of plan) console.log(`${APPLY ? 'APPLY' : 'DRY  '} ${w.kind.padEnd(12)} ${w.label}`)
  console.log(`${plan.length} write(s) planned${APPLY ? '' : ' — re-run with --apply to write them'}`)
  if (!APPLY || plan.length === 0) return

  const backup = `offer-supplier-fk-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  fs.writeFileSync(backup, JSON.stringify(plan, null, 2))
  console.log(`backup written: ${backup}`)
  for (const w of plan) {
    if (w.kind === 'session-link') await prisma.invoiceSession.update({ where: { id: w.id }, data: w.after as { supplierId: string } })
    else await prisma.inventorySupplierPrice.update({ where: { id: w.id }, data: w.after as { supplierId?: string; supplierName?: string } })
  }
  console.log(`${plan.length} row(s) written`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
