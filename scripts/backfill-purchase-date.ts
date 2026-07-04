/**
 * One-time: populate InvoiceSession.purchaseDate for every existing session.
 *
 * purchaseDate is the reporting date a purchase lands on — the invoice's own date,
 * falling back to approvedAt then createdAt. ALL purchase-spend reporting windows on
 * it (see src/lib/purchase-date.ts). Run after the 20260703_invoice_purchase_date
 * migration adds the (nullable) column. Idempotent — safe to re-run; it only fills
 * rows where purchaseDate is still null.
 */
import { prisma } from '../src/lib/prisma'
import { resolvePurchaseDate } from '../src/lib/purchase-date'

async function main() {
  const sessions = await prisma.invoiceSession.findMany({
    where: { purchaseDate: null },
    select: { id: true, invoiceDate: true, approvedAt: true, createdAt: true },
  })
  console.log(`Sessions needing purchaseDate: ${sessions.length}`)

  let fromInvoice = 0, fromApproved = 0, fromCreated = 0
  for (const s of sessions) {
    const pd = resolvePurchaseDate(s.invoiceDate, s.approvedAt, s.createdAt)
    if (s.invoiceDate && !isNaN(new Date(s.invoiceDate).getTime())) fromInvoice++
    else if (s.approvedAt) fromApproved++
    else fromCreated++
    await prisma.invoiceSession.update({ where: { id: s.id }, data: { purchaseDate: pd } })
  }

  console.log(`  ${fromInvoice} from invoiceDate, ${fromApproved} from approvedAt, ${fromCreated} from createdAt`)
  const remaining = await prisma.invoiceSession.count({ where: { purchaseDate: null } })
  console.log(remaining === 0 ? '✓ every session has a purchaseDate' : `✗ ${remaining} still null`)
  await prisma.$disconnect()
  process.exit(remaining === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
