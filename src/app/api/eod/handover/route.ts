import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

// Latest CLOSED close BEFORE today for the RC, with a non-empty handover note.
export async function GET(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const rcId = new URL(req.url).searchParams.get('rcId')
    if (!rcId) return NextResponse.json(null)
    const today = businessDateLocal()
    const close = await prisma.eodClose.findFirst({
      where: { revenueCenterId: rcId, status: 'CLOSED', businessDate: { lt: today }, NOT: { handoverNote: null } },
      orderBy: { businessDate: 'desc' },
      select: { handoverNote: true, signedOffByName: true, businessDate: true },
    })
    if (!close || !close.handoverNote?.trim()) return NextResponse.json(null)
    return NextResponse.json(close, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/eod/handover', e)
    return NextResponse.json(null)
  }
}
