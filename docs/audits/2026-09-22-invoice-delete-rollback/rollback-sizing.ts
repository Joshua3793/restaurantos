/** READ-ONLY. Sizes the invoice-delete-rollback rollout: how many APPROVED sessions are
 *  "legacy" (no undo records to roll back to — every one of them, until this ships), how
 *  many RC-split clones exist (delete now refuses these directly), how many approved
 *  sessions carry an ADD_SUPPLIER line (today's revert silently skips these; the legacy
 *  path now covers them too), how many supplier offers still point at a session that no
 *  longer exists (evidence of a past un-rolled-back delete), and how many APPROVED sessions
 *  look like clones orphaned by a parent delete before this fix shipped (the schema's
 *  default SetNull on `parentSessionId` nulls the pointer instead of taking the clone with
 *  its parent). Run: npx tsx <this file> */
import { prisma } from '../../../src/lib/prisma'

async function main() {
  const [approvedTotal, clonesTotal, addSupplierSessions, offersWithSession, allSessions] = await Promise.all([
    prisma.invoiceSession.count({ where: { status: 'APPROVED' } }),
    prisma.invoiceSession.count({ where: { parentSessionId: { not: null } } }),
    prisma.invoiceSession.count({ where: { status: 'APPROVED', scanItems: { some: { action: 'ADD_SUPPLIER' } } } }),
    prisma.inventorySupplierPrice.findMany({ where: { lastInvoiceSessionId: { not: null } }, select: { id: true, supplierName: true, lastInvoiceSessionId: true, inventoryItem: { select: { itemName: true } } } }),
    prisma.invoiceSession.findMany({ select: { id: true } }),
  ])

  const sessionIds = new Set(allSessions.map(s => s.id))
  const orphanOffers = offersWithSession.filter(o => o.lastInvoiceSessionId && !sessionIds.has(o.lastInvoiceSessionId))

  // Orphaned-clone proxy. A clone is created (approve/route.ts) with `status: 'APPROVED'`,
  // `invoiceNumber: \`${parent.invoiceNumber} (copy)\``, and no InvoiceFile rows of its own.
  // `parentSessionId` is an optional FK with no explicit onDelete, so Prisma emits the
  // default SetNull — deleting the parent today (before this fix) nulls the clone's pointer
  // instead of removing it, and the clone silently keeps counting its share of the invoice's
  // spend forever. Neither signal alone is safe (a real invoice could be misnamed, or could
  // genuinely have no attached file), but the conjunction — APPROVED, no parent, a
  // "(copy)" name, and zero files — is the exact shape every clone has and no ordinarily
  // uploaded session should have. This is a proxy, not a certainty: it is reported as a
  // candidate count for the controller to eyeball, not acted on.
  const orphanCloneCandidates = await prisma.invoiceSession.findMany({
    where: { status: 'APPROVED', parentSessionId: null, invoiceNumber: { endsWith: '(copy)' } },
    select: { id: true, invoiceNumber: true, supplierName: true, purchaseDate: true, _count: { select: { files: true } } },
  })
  const orphanClones = orphanCloneCandidates.filter(s => s._count.files === 0)

  console.log(
    `${approvedTotal} APPROVED sessions (all legacy today — no undo records exist before this migration) · ` +
    `${clonesTotal} RC clones (parentSessionId set; delete now refuses these directly, deletes with their parent) · ` +
    `${addSupplierSessions} approved sessions with >=1 ADD_SUPPLIER line (today's revert silently skips these) · ` +
    `${orphanOffers.length} offers pointing at a deleted session (evidence of a past un-rolled-back delete) · ` +
    `${orphanClones.length}/${orphanCloneCandidates.length} likely-orphaned clones (proxy: APPROVED, no parent, "(copy)" name, 0 files)`
  )

  console.log('\n=== OFFERS POINTING AT A DELETED SESSION ===')
  console.table(orphanOffers.slice(0, 50).map(o => ({ id: o.id, item: o.inventoryItem.itemName, supplierName: o.supplierName, lastInvoiceSessionId: o.lastInvoiceSessionId })))

  console.log('\n=== LIKELY-ORPHANED CLONES (proxy match) ===')
  console.table(orphanClones.slice(0, 50).map(s => ({ id: s.id, invoiceNumber: s.invoiceNumber, supplierName: s.supplierName, purchaseDate: s.purchaseDate })))

  const { writeFileSync } = await import('node:fs')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(`rollback-sizing-${stamp}.json`, JSON.stringify({
    approvedTotal,
    clonesTotal,
    addSupplierSessions,
    orphanOffers,
    orphanCloneCandidateCount: orphanCloneCandidates.length,
    orphanClones,
  }, null, 2))
  console.log(`\nfull dump → rollback-sizing-${stamp}.json`)
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
