import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { parseClocksWorkbook, parseSalesWorkbook } from '@/lib/tips/xlsx'
import { addDays, periodDays } from '@/lib/tips/period'
import { loadSettings } from '@/lib/tips/settings'

export const dynamic = 'force-dynamic'
/** Workbooks are small; the default body limit is plenty. Guard anyway. */
const MAX_BYTES = 8 * 1024 * 1024

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({ where: { id: params.id } })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })
    if (period.status === 'PAID')
      return NextResponse.json({ error: 'This period is paid. Reopen it before importing.' }, { status: 409 })

    const form = await req.formData()
    const file = form.get('file')
    const kind = String(form.get('kind') ?? '')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'That workbook is too large.' }, { status: 400 })
    if (kind !== 'sales' && kind !== 'clocks')
      return NextResponse.json({ error: "kind must be 'sales' or 'clocks'" }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const settings = await loadSettings()
    const days = periodDays(period.startDate, settings.periodDays)

    if (kind === 'sales') {
      let parsed
      try { parsed = parseSalesWorkbook(buffer) }
      catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

      // Map the workbook's rows onto the period's days; a day the workbook does
      // not cover keeps whatever the app already has (override stays null).
      const byDate = new Map(parsed.iso.map((iso, i) => [iso, parsed.sales[i]]))
      const override = days.map(d => byDate.get(d) ?? null)
      const matched = override.filter(v => v != null).length
      // The Sales Summary carries a tips column on some Toast configurations.
      // When present it overrides the app's tip figures the same way. `null`
      // (the workbook said nothing about tips) must never be stored as zeros.
      const tipsByDate = parsed.tips ? new Map(parsed.iso.map((iso, i) => [iso, parsed.tips![i]])) : null
      const tipsOverride = tipsByDate ? days.map(d => tipsByDate.get(d) ?? null) : undefined
      if (matched === 0) {
        return NextResponse.json({
          error: `That workbook covers ${parsed.iso[0]} → ${parsed.iso[parsed.iso.length - 1]}, which does not overlap this period (${period.startDate} → ${period.endDate}).`,
        }, { status: 400 })
      }

      await prisma.tipPeriod.update({
        where: { id: params.id },
        data: {
          salesOverride: override,
          ...(tipsOverride ? { tipsOverride } : {}),
          salesFileName: file.name,
          salesImportedAt: new Date(),
        },
      })
      const total = override.reduce<number>((a, v) => a + (v ?? 0), 0)
      const tipTotal = tipsOverride?.reduce<number>((a, v) => a + (v ?? 0), 0) ?? null
      return NextResponse.json({
        ok: true,
        summary: {
          days: matched,
          total: Math.round(total * 100) / 100,
          reportedNet: parsed.reportedNet,
          tipsTotal: tipTotal == null ? null : Math.round(tipTotal * 100) / 100,
          // Rows with a valid date but an unreadable sales figure — silently
          // dropped otherwise. The manager needs to see this to trust the total.
          unparsedRows: parsed.unparsedRows,
        },
      })
    }

    let parsed
    try { parsed = parseClocksWorkbook(buffer, period.startDate, settings.periodDays) }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

    // A workbook for a completely different period would otherwise wipe out
    // every existing punch and replace it with rows the audit can only bucket
    // as "dated outside the period" — silently destructive. Reject up front,
    // before the transaction, the same way the sales branch rejects a
    // non-overlapping workbook above.
    if (parsed.outside === parsed.rows.length) {
      const indices = parsed.rows.map(r => r.dayIndex)
      const first = addDays(period.startDate, Math.min(...indices))
      const last = addDays(period.startDate, Math.max(...indices))
      return NextResponse.json({
        error: `That workbook covers ${first} → ${last}, which does not overlap this period (${period.startDate} → ${period.endDate}).`,
      }, { status: 400 })
    }

    // A re-import replaces the period's punches wholesale, and clears the
    // ignore list — the codes it named may not exist in the new file. All in
    // one transaction so a mid-way failure can never leave the period with
    // some punches deleted and none (or only some) re-created.
    await prisma.$transaction([
      prisma.tipPunch.deleteMany({ where: { periodId: params.id } }),
      prisma.tipPunch.createMany({
        data: parsed.rows.map(r => ({
          periodId: params.id,
          clockId: r.clockId,
          firstName: r.firstName,
          lastName: r.lastName,
          position: r.position,
          department: r.department,
          dayIndex: r.dayIndex,
          hours: r.hours,
          status: r.status,
          note: r.note,
        })),
      }),
      prisma.tipPeriod.update({
        where: { id: params.id },
        data: { clockFileName: file.name, clockImportedAt: new Date(), ignoredClockIds: [] },
      }),
    ])

    const known = new Set(
      (await prisma.cook.findMany({ where: { clockId: { not: null } }, select: { clockId: true } }))
        .map(c => String(c.clockId)),
    )
    const strangers = [...new Set(parsed.rows.map(r => r.clockId))].filter(c => !known.has(c)).length

    return NextResponse.json({
      ok: true,
      summary: {
        shifts: parsed.rows.length,
        hours: parsed.total,
        people: parsed.peopleCount,
        outside: parsed.outside,
        pending: parsed.pending,
        strangers,
        // Rows with a Clock ID and a date but an unreadable hours figure —
        // silently dropped otherwise.
        unparsedRows: parsed.unparsedRows,
      },
    })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/import POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
