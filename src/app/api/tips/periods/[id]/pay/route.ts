import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { buildPeriodSplit } from '@/lib/tips/build'

export const dynamic = 'force-dynamic'

/**
 * Freezes the period. The snapshot is the whole SplitResult + AuditResult at
 * the moment of payment, so what was actually handed out stays readable even
 * after a rate change, a roster edit, or a sales correction — split.people[]
 * already carries each person's RESOLVED dailyHourCap, roleId, roleName and
 * multiplier as of build time (see build.ts), which is what preserves those
 * even though Cook/TipRole rows are mutable and will keep changing.
 *
 * A period with unresolved ERRORS cannot be paid — that is the entire point of
 * the Checks tab. Warnings and info do not block.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({ where: { id: params.id } })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })

    const body = await req.json().catch(() => ({}))

    if (body.reopen === true) {
      if (period.status !== 'PAID') return NextResponse.json({ error: 'This period is not paid.' }, { status: 409 })
      await prisma.tipPeriod.update({
        where: { id: params.id },
        data: { status: 'DRAFT', paidAt: null, paidByName: null },
      })
      return NextResponse.json({ ok: true, status: 'DRAFT' })
    }

    if (period.status === 'PAID') return NextResponse.json({ error: 'This period is already paid.' }, { status: 409 })

    const built = await buildPeriodSplit(user, params.id)
    if (!built) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (built.audit.counts.error > 0) {
      return NextResponse.json({
        error: `${built.audit.counts.error} unresolved ${built.audit.counts.error === 1 ? 'issue' : 'issues'} on the Checks tab. Settle them before paying.`,
        findings: built.audit.findings.filter(f => f.severity === 'error').map(f => f.title),
      }, { status: 409 })
    }

    await prisma.tipPeriod.update({
      where: { id: params.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paidByName: user.name ?? user.email,
        snapshot: {
          paidAt: new Date().toISOString(),
          poolBasis: built.poolBasis,
          poolRatePct: built.poolRatePct,
          roundingStepCents: built.roundingStepCents,
          dayLabels: built.dayLabels,
          basis: built.basis,
          sales: built.sales,
          tips: built.tips,
          tipTotal: built.tipTotal,
          roles: built.roles,
          // split.people[] is the permanent per-person record: hours, weighted
          // hours, tip, envelope AND their resolved dailyHourCap/roleId/roleName/
          // multiplier at the moment of payment.
          split: built.split,
          audit: built.audit,
        } as unknown as object,
      },
    })
    return NextResponse.json({ ok: true, status: 'PAID' })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/pay POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
