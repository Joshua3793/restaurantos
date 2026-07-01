import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const rcId = String((await req.json()).rcId ?? '')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const date = businessDateLocal()
    await prisma.eodClose.updateMany({
      where: { revenueCenterId: rcId, businessDate: date },
      data: { status: 'DRAFT', signedOffBy: null, signedOffByName: null, signedOffAt: null, snapshot: Prisma.DbNull },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/eod/close/reopen', e)
    return NextResponse.json({ error: 'Failed to reopen' }, { status: 500 })
  }
}
