import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
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
