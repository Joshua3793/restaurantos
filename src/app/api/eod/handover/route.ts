import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

// The most recent CLOSED close BEFORE today for the RC — the artifact the next
// morning's Pass opens with ("From last night's close" band). Returns the close
// regardless of whether a handover note was written: the reconciled snapshot
// (netSales/covers/foodCostPct) and sign-off time are useful on their own, and
// the note is just one optional field of the payload.
export async function GET(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const rcId = new URL(req.url).searchParams.get('rcId')
    if (!rcId) return NextResponse.json(null)
    const today = businessDateLocal()
    const close = await prisma.eodClose.findFirst({
      where: { revenueCenterId: rcId, status: 'CLOSED', businessDate: { lt: today } },
      orderBy: { businessDate: 'desc' },
      select: {
        handoverNote: true,
        signedOffByName: true,
        signedOffAt: true,
        businessDate: true,
        snapshot: true,
      },
    })
    if (!close) return NextResponse.json(null)
    return NextResponse.json(close, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/eod/handover', e)
    return NextResponse.json(null)
  }
}
