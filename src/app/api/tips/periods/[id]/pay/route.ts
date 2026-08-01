import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { buildPeriodSplit } from '@/lib/tips/build'
import { appendPayout, reopenSnapshot } from '@/lib/tips/snapshot'

export const dynamic = 'force-dynamic'

/**
 * Freezes the period. The snapshot is the whole SplitResult + AuditResult at
 * the moment of payment, so what was actually handed out stays readable even
 * after a rate change, a roster edit, or a sales correction — split.people[]
 * already carries each person's RESOLVED dailyHourCap, roleId, roleName and
 * multiplier as of build time (see build.ts), which is what preserves those
 * even though Cook/TipRole rows are mutable and will keep changing.
 *
 * PAYING IS APPEND-ONLY. Cash physically left the building, so a re-pay after
 * a reopen never overwrites the earlier payout: `appendPayout` pushes the old
 * one onto `snapshot.history` and the new one becomes `snapshot.current`, each
 * with its own `paidAt` and `paidByName`. Reopening moves `current` onto
 * `history` and leaves `current` null — the period stops looking paid without
 * the record of the disbursement being destroyed. See lib/tips/snapshot.ts.
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
      // Guarded on status so two concurrent reopens cannot both "succeed" and
      // push the same payout onto history twice.
      const reopened = reopenSnapshot(period.snapshot)
      const { count } = await prisma.tipPeriod.updateMany({
        where: { id: params.id, status: 'PAID' },
        data: {
          status: 'DRAFT',
          // The mutable columns are cleared because the period is no longer
          // paid — the authoriser is NOT lost with them: it was captured
          // inside the payout record at pay time.
          paidAt: null,
          paidByName: null,
          // Left untouched when there is nothing to retain (a PAID row with no
          // snapshot at all should not gain an empty one).
          ...(reopened ? { snapshot: reopened as unknown as object } : {}),
        },
      })
      if (count === 0) return NextResponse.json({ error: 'This period is not paid.' }, { status: 409 })
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

    const paidAt = new Date()
    const paidByName = user.name ?? user.email
    const snapshot = appendPayout(period.snapshot, {
      paidAt: paidAt.toISOString(),
      // Captured INSIDE the record: TipPeriod.paidByName is nulled on reopen,
      // so it alone cannot survive a reopen → re-pay cycle.
      paidByName,
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
    })

    // Optimistic concurrency: two managers hitting Pay at the same moment both
    // read DRAFT and both build. Without the status in the WHERE, the second
    // write would silently overwrite the first payout as `current`. The loser
    // gets the same 409 as any other already-paid attempt.
    const { count } = await prisma.tipPeriod.updateMany({
      where: { id: params.id, status: 'DRAFT' },
      data: {
        status: 'PAID',
        paidAt,
        paidByName,
        snapshot: snapshot as unknown as object,
      },
    })
    if (count === 0) return NextResponse.json({ error: 'This period is already paid.' }, { status: 409 })

    return NextResponse.json({ ok: true, status: 'PAID' })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/pay POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
