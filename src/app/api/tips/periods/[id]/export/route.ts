import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { buildPeriodSplit } from '@/lib/tips/build'

export const dynamic = 'force-dynamic'

/** RFC-4180 quoting — a surname with a comma must not shift every column. */
const cell = (v: unknown) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({ where: { id: params.id } })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })

    const built = await buildPeriodSplit(user, params.id)
    if (!built) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const { split } = built

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
    rows.push(['Pool basis', built.poolBasis === 'TIPS_COLLECTED' ? 'Tips collected' : 'Net sales'])
    rows.push(['Pool rate', `${built.poolRatePct}%`])
    rows.push(['Net sales', built.sales.reduce((a, b) => a + b, 0).toFixed(2)])
    rows.push(['Tips collected', built.tipTotal.toFixed(2)])
    rows.push(['Pool total (all day pools)', split.poolTotal.toFixed(2)])
    rows.push(['Distributed to people', split.distributedTotal.toFixed(2)])
    // poolTotal can exceed distributedTotal on a day with sales but nobody
    // clocked in — that money never reaches anyone's envelope.
    rows.push(['Undistributed (no crew that day)', (split.poolTotal - split.distributedTotal).toFixed(2)])
    rows.push([
      'Tip-out share of the tip pot',
      built.tipTotal > 0 ? `${((split.distributedTotal / built.tipTotal) * 100).toFixed(1)}%` : 'n/a',
    ])
    rows.push([
      'Left for front of house',
      built.tipTotal > 0 ? (built.tipTotal - split.distributedTotal).toFixed(2) : 'n/a',
    ])
    rows.push(['Envelopes total', (split.envelopeTotalCents / 100).toFixed(2)])
    rows.push(['Status', period.status])

    const csv = rows.map(r => r.map(cell).join(',')).join('\n')
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
