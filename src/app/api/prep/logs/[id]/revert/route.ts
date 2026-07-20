import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

// Mutating handlers must never be statically prerendered — a prerendered
// route serves GET only and returns 405 for everything else.
export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const newActualPrepQty = parseFloat(String(body.newActualPrepQty))

  if (!newActualPrepQty || isNaN(newActualPrepQty)) {
    return NextResponse.json({ error: 'newActualPrepQty is required' }, { status: 400 })
  }

  const log = await prisma.prepLog.findUnique({
    where: { id: params.id },
  })

  if (!log) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const prevQty = parseFloat(String(log.actualPrepQty ?? 0))

  await prisma.prepLog.update({
    where: { id: params.id },
    data: { actualPrepQty: newActualPrepQty },
  })

  return NextResponse.json({ ok: true, previousQty: prevQty, newQty: newActualPrepQty })
}
