// Read-only verification of the invoice-date reporting switch.
// Run: npx tsx scripts/verify-purchase-date.ts
import { prisma } from '../src/lib/prisma'

const money = (n: number) => `$${n.toFixed(2)}`
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—')

// Mirror periodPurchases(): approved, non-split scan items, summed on rawLineTotal,
// windowed by session.<field> in [start, end].
async function purchases(field: 'purchaseDate' | 'approvedAt', start: Date, end: Date) {
  const items = await prisma.invoiceScanItem.findMany({
    where: { approved: true, splitToSessionId: null, session: { [field]: { gte: start, lte: end } } },
    select: { rawLineTotal: true, sessionId: true },
  })
  let total = 0
  const sessions = new Set<string>()
  for (const it of items) {
    if (it.rawLineTotal == null) continue
    total += Number(it.rawLineTotal)
    sessions.add(it.sessionId)
  }
  return { total, invoices: sessions.size }
}

async function main() {
  const juneStart = new Date('2026-06-01')
  const juneEnd = new Date('2026-06-30T23:59:59.999Z')
  const julyStart = new Date('2026-07-01')
  const julyEnd = new Date('2026-07-31T23:59:59.999Z')

  // 1) Sessions whose attribution MOVED: invoice month ≠ approval month.
  const approved = await prisma.invoiceSession.findMany({
    where: { status: 'APPROVED', parentSessionId: null, purchaseDate: { not: null } },
    select: { supplierName: true, invoiceDate: true, approvedAt: true, purchaseDate: true, total: true },
    orderBy: { purchaseDate: 'desc' },
  })
  const moved = approved.filter(s => {
    if (!s.approvedAt || !s.purchaseDate) return false
    return s.purchaseDate.toISOString().slice(0, 7) !== s.approvedAt.toISOString().slice(0, 7)
  })

  console.log(`\n── Invoices whose month CHANGED (invoice date ≠ approval month): ${moved.length} ──`)
  for (const s of moved.slice(0, 25)) {
    console.log(
      `  ${(s.supplierName ?? '—').padEnd(22).slice(0, 22)}  ` +
      `invoice ${ymd(s.purchaseDate)}  approved ${ymd(s.approvedAt)}  ${money(Number(s.total ?? 0))}  ` +
      `→ now counts in ${s.purchaseDate!.toISOString().slice(0, 7)} (was ${s.approvedAt!.toISOString().slice(0, 7)})`
    )
  }
  if (moved.length > 25) console.log(`  …and ${moved.length - 25} more`)

  // 2) June & July purchases: NEW (by invoice date) vs OLD (by approval date).
  const [juneNew, juneOld, julyNew, julyOld] = await Promise.all([
    purchases('purchaseDate', juneStart, juneEnd),
    purchases('approvedAt', juneStart, juneEnd),
    purchases('purchaseDate', julyStart, julyEnd),
    purchases('approvedAt', julyStart, julyEnd),
  ])

  console.log('\n── June 2026 purchases ──')
  console.log(`  NEW (by invoice date):  ${money(juneNew.total)}  (${juneNew.invoices} invoices)`)
  console.log(`  OLD (by approval date): ${money(juneOld.total)}  (${juneOld.invoices} invoices)`)
  console.log(`  Δ moved into June:      ${money(juneNew.total - juneOld.total)}`)

  console.log('\n── July 2026 purchases ──')
  console.log(`  NEW (by invoice date):  ${money(julyNew.total)}  (${julyNew.invoices} invoices)`)
  console.log(`  OLD (by approval date): ${money(julyOld.total)}  (${julyOld.invoices} invoices)`)
  console.log(`  Δ moved out of July:    ${money(julyNew.total - julyOld.total)}`)

  // 3) Conservation check: total across all approved purchases is unchanged — money is
  //    only redistributed between periods, never created or lost.
  const grand = await purchases('purchaseDate', new Date('2000-01-01'), new Date('2100-01-01'))
  const grandOld = await purchases('approvedAt', new Date('2000-01-01'), new Date('2100-01-01'))
  console.log('\n── Conservation (all-time total must match) ──')
  console.log(`  by invoice date:  ${money(grand.total)}`)
  console.log(`  by approval date: ${money(grandOld.total)}`)
  console.log(`  ${Math.abs(grand.total - grandOld.total) < 0.005 ? '✓ totals match — money only redistributed' : '✗ MISMATCH'}`)

  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
