/**
 * List PENDING/SKIP/unmatched lines on APPROVED invoices — purchases paid but not
 * credited to any item's stock. Grouped by invoice so they can be matched.
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/list-unmatched-purchase-lines.ts
 */
import { prisma } from '../src/lib/prisma'

const money = (n: number) => '$' + n.toFixed(2)

async function main() {
  const sessions = await prisma.invoiceSession.findMany({
    where: { status: 'APPROVED', parentSessionId: null },
    select: {
      id: true, supplierName: true, invoiceNumber: true, invoiceDate: true, approvedAt: true,
      revenueCenter: { select: { name: true } },
      scanItems: {
        select: {
          action: true, matchedItemId: true, rawDescription: true, rawLineTotal: true,
          rawQty: true, rawUnit: true, supplierItemCode: true, matchScore: true,
        },
      },
    },
    orderBy: { approvedAt: 'asc' },
  })

  let grandTotal = 0, pendingTotal = 0, skipTotal = 0, lineCount = 0
  const blocks: string[] = []

  for (const s of sessions) {
    const orphans = s.scanItems.filter(li => li.action === 'PENDING' || li.action === 'SKIP' || !li.matchedItemId)
    if (orphans.length === 0) continue
    const subtotal = orphans.reduce((a, o) => a + Number(o.rawLineTotal || 0), 0)
    grandTotal += subtotal
    lineCount += orphans.length

    const hdr = `┌─ ${s.supplierName ?? 'Unknown'}  ·  #${s.invoiceNumber ?? '—'}  ·  ${s.invoiceDate ?? s.approvedAt?.toISOString().slice(0,10) ?? '—'}  ·  RC ${s.revenueCenter?.name ?? '—'}`
    const sid = `│  session: ${s.id}   (${money(subtotal)} unmatched here)`
    const lines = orphans
      .sort((a, b) => Number(b.rawLineTotal || 0) - Number(a.rawLineTotal || 0))
      .map(o => {
        const t = Number(o.rawLineTotal || 0)
        if (o.action === 'PENDING' || !o.matchedItemId) pendingTotal += t; else skipTotal += t
        const qty = o.rawQty != null ? `${Number(o.rawQty)} ${o.rawUnit ?? ''}`.trim() : ''
        const code = o.supplierItemCode ? ` [${o.supplierItemCode}]` : ''
        return `│    ${money(t).padStart(9)}  ${(o.action || '—').padEnd(8)} ${qty.padEnd(10)} ${o.rawDescription.slice(0, 44)}${code}`
      })
    blocks.push([hdr, sid, ...lines, '└' + '─'.repeat(60)].join('\n'))
  }

  console.log(`Unmatched/pending/skip lines on approved invoices: ${lineCount} lines across ${blocks.length} invoices`)
  console.log(`  PENDING/unmatched (likely should be matched): ${money(pendingTotal)}`)
  console.log(`  SKIP (may be intentional — charges/non-inventory): ${money(skipTotal)}`)
  console.log(`  TOTAL not feeding stock: ${money(grandTotal)}\n`)
  console.log(blocks.join('\n'))

  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
