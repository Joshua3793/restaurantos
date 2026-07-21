import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal, computeTempsReady, computeProgress } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const user = await requireSession('LEAD')
    const rcId = new URL(req.url).searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const date = businessDateLocal()

    const [items, close] = await Promise.all([
      prisma.eodCheckItem.findMany({
        where: { revenueCenterId: rcId, isActive: true },
        select: { id: true, section: true, title: true, meta: true, sortOrder: true, isBlocker: true },
        orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
      }),
      prisma.eodClose.upsert({
        where: { revenueCenterId_businessDate: { revenueCenterId: rcId, businessDate: date } },
        create: { revenueCenterId: rcId, businessDate: date },
        update: {},
        select: {
          id: true, status: true, handoverNote: true, signedOffByName: true, signedOffAt: true, snapshot: true,
          labourCost: true, grossSales: true, compsVoids: true, discounts: true,
          entries: { select: { itemId: true, done: true } },
        },
      }),
    ])

    const doneIds = new Set(close.entries.filter(e => e.done).map(e => e.itemId))
    const temps = await computeTempsReady(rcId, date)
    const progress = computeProgress(items.map(i => ({ id: i.id, isBlocker: i.isBlocker })), doneIds, temps)

    return NextResponse.json({
      date,
      items,
      doneItemIds: [...doneIds],
      close: {
        id: close.id, status: close.status, handoverNote: close.handoverNote,
        signedOffByName: close.signedOffByName, signedOffAt: close.signedOffAt,
        // Shift Leads run the close but never see money (see the clearance
        // ladder: "No cost or money"). `snapshot` is the sign-off money
        // capture written by POST .../signoff (netSales/foodCostDollars/
        // foodCostPct, etc) — since sign-off is now LEAD-accessible, it must
        // be omitted here too or a Lead could sign off their own close and
        // read the $ figures straight back out of this GET. Omitted entirely
        // rather than nulled, so the client cannot mistake "hidden" for "not
        // yet entered".
        ...(user.role === 'LEAD' ? {} : {
          snapshot: close.snapshot,
          labourCost: close.labourCost == null ? null : Number(close.labourCost),
          grossSales: close.grossSales == null ? null : Number(close.grossSales),
          compsVoids: close.compsVoids == null ? null : Number(close.compsVoids),
          discounts: close.discounts == null ? null : Number(close.discounts),
        }),
      },
      progress,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/eod/close', e)
    return NextResponse.json({ error: 'Failed to load close' }, { status: 500 })
  }
}

// Parse an optional numeric close-out field: undefined = don't touch, null/'' = clear, else = set.
function parseOptionalNumber(v: unknown): number | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireSession('LEAD')
    const body = await req.json()
    const rcId = String(body.rcId ?? '')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const date = businessDateLocal()

    const labourCost = parseOptionalNumber(body.labourCost)
    const grossSales = parseOptionalNumber(body.grossSales)
    const compsVoids = parseOptionalNumber(body.compsVoids)
    const discounts = parseOptionalNumber(body.discounts)
    const handoverNote = body.handoverNote === undefined ? undefined : String(body.handoverNote ?? '')

    // A Lead may write the handover note, nothing else on this route — the
    // clearance ladder gives Leads "No cost or money".
    if (user.role === 'LEAD') {
      const attempted = [labourCost, grossSales, compsVoids, discounts]
        .some(v => v !== undefined)
      if (attempted) {
        return NextResponse.json(
          { error: 'Shift Leads cannot record labour, sales, comps or discounts.' },
          { status: 403 },
        )
      }
    }

    const data = {
      ...(handoverNote !== undefined ? { handoverNote } : {}),
      ...(labourCost !== undefined ? { labourCost } : {}),
      ...(grossSales !== undefined ? { grossSales } : {}),
      ...(compsVoids !== undefined ? { compsVoids } : {}),
      ...(discounts !== undefined ? { discounts } : {}),
    }

    await prisma.eodClose.upsert({
      where: { revenueCenterId_businessDate: { revenueCenterId: rcId, businessDate: date } },
      create: { revenueCenterId: rcId, businessDate: date, ...data },
      update: data,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/eod/close', e)
    return NextResponse.json({ error: 'Failed to save handover' }, { status: 500 })
  }
}
