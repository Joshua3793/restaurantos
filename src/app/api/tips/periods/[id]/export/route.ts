import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { buildPeriodSplit } from '@/lib/tips/build'
import { payoutsInOrder, readSnapshot } from '@/lib/tips/snapshot'
import type { SplitResult } from '@/lib/tips/types'

export const dynamic = 'force-dynamic'

/**
 * RFC-4180 quoting, plus spreadsheet formula neutralisation.
 *
 * A cell whose text begins `=`, `+`, `-` or `@` (or a control char Excel
 * tolerates as a lead-in) is EXECUTED on open — a payroll sheet carrying staff
 * names is exactly the place a hostile or accidental `=…` must not run. Such
 * cells are prefixed with an apostrophe, which Excel and Sheets both read as
 * "this is literal text".
 *
 * Numeric-looking cells are exempt: `-1.00` in the Undistributed row is a real
 * negative number, not a formula, and quoting it as text would break the sheet
 * for the accountant who has to add it up.
 */
const cell = (v: unknown) => {
  let s = String(v ?? '')
  const numeric = s.trim() !== '' && isFinite(Number(s))
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

interface ExportView {
  split: SplitResult
  poolBasis: string
  poolRatePct: number
  sales: number[]
  tipTotal: number
  /** What the reader is looking at — printed into the sheet itself. */
  source: string
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({ where: { id: params.id } })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })

    // A PAID period renders from the FROZEN payout, never a live rebuild.
    // Re-exporting after payment used to recompute against the current roster,
    // caps and sales and then stamp the sheet "PAID" — a payroll hand-off
    // document that disagreed with the envelopes actually handed out. Which
    // payout: the latest, i.e. `snapshot.current`, and the sheet says so by
    // number so a re-export after a reopen → re-pay is unambiguous.
    const snap = readSnapshot(period.snapshot)
    const frozen = period.status === 'PAID' ? snap?.current ?? null : null

    let view: ExportView
    if (frozen) {
      const total = payoutsInOrder(snap).length + (snap?.trimmed ?? 0)
      view = {
        split: frozen.split,
        poolBasis: frozen.poolBasis,
        poolRatePct: frozen.poolRatePct,
        sales: frozen.sales,
        tipTotal: frozen.tipTotal,
        source: `Frozen payout #${frozen.seq} of ${total} · paid ${frozen.paidAt} by ${frozen.paidByName ?? 'unknown'}`,
      }
    } else {
      // DRAFT — or, defensively, a PAID row whose snapshot is missing or
      // unreadable. Either way the sheet says the numbers are live so nobody
      // mistakes a recomputation for the record of a disbursement.
      const built = await buildPeriodSplit(user, params.id)
      if (!built) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      view = {
        split: built.split,
        poolBasis: built.poolBasis,
        poolRatePct: built.poolRatePct,
        sales: built.sales,
        tipTotal: built.tipTotal,
        source: period.status === 'PAID'
          ? 'Live recalculation — this period is PAID but has no readable frozen payout'
          : 'Live recalculation (DRAFT — not yet paid)',
      }
    }
    const { split } = view

    const rows: unknown[][] = [[
      'Name', 'Surname', 'Code', 'Role', 'Weight', 'Hours', 'Weighted hours',
      'Rewarded days', '$ per hour', 'Share %', 'Tips exact', 'Envelope',
    ]]
    for (const p of split.people) {
      rows.push([
        p.name, p.lastName ?? '', p.clockId ?? '', p.roleName, p.multiplier,
        p.hoursTotal.toFixed(2), p.weighted.toFixed(2),
        p.boosts.filter(b => b > 1).length,
        p.hoursTotal ? (p.tip / p.hoursTotal).toFixed(2) : '0.00',
        // Against distributedTotal (money actually owed to people), not
        // poolTotal — poolTotal can include a day pool nobody was on shift to
        // earn, which would make every share % on this sheet fail to sum to 100.
        split.distributedTotal ? ((p.tip / split.distributedTotal) * 100).toFixed(2) : '0.00',
        p.tip.toFixed(2), (p.envelopeCents / 100).toFixed(2),
      ])
    }
    rows.push([])
    rows.push(['Period', `${period.startDate} → ${period.endDate}`])
    rows.push(['Pool basis', view.poolBasis === 'TIPS_COLLECTED' ? 'Tips collected' : 'Net sales'])
    rows.push(['Pool rate', `${view.poolRatePct}%`])
    rows.push(['Net sales', view.sales.reduce((a, b) => a + b, 0).toFixed(2)])
    rows.push(['Tips collected', view.tipTotal.toFixed(2)])
    rows.push(['Pool total (all day pools)', split.poolTotal.toFixed(2)])
    rows.push(['Distributed to people', split.distributedTotal.toFixed(2)])
    // poolTotal can exceed distributedTotal on a day with sales but nobody
    // clocked in — that money never reaches anyone's envelope.
    rows.push(['Undistributed (no crew that day)', (split.poolTotal - split.distributedTotal).toFixed(2)])
    rows.push([
      'Tip-out share of the tip pot',
      view.tipTotal > 0 ? `${((split.distributedTotal / view.tipTotal) * 100).toFixed(1)}%` : 'n/a',
    ])
    rows.push([
      'Left for front of house',
      view.tipTotal > 0 ? (view.tipTotal - split.distributedTotal).toFixed(2) : 'n/a',
    ])
    rows.push(['Envelopes total', (split.envelopeTotalCents / 100).toFixed(2)])
    rows.push(['Status', period.status])
    rows.push(['Figures', view.source])

    // CRLF per RFC-4180, and a UTF-8 BOM so Excel on Windows reads accented
    // names as UTF-8 instead of mojibaking them through the ANSI code page.
    const csv = '\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n')
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="kitchen-tips-${period.startDate}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/export GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
