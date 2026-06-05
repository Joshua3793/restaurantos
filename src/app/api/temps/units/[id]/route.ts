import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const num = (v: unknown) => (v == null ? null : Number(v))

// ── PATCH /api/temps/units/[id] ───────────────────────────────────────────────
// Edit name and/or safe range. Pass null (or '') for a one-sided limit.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const body = await req.json()
    const data: Record<string, unknown> = {}

    if (body.name !== undefined) {
      const n = String(body.name).trim()
      if (!n) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      data.name = n
    }
    if (body.safeMin !== undefined) data.safeMin = body.safeMin === null || body.safeMin === '' ? null : Number(body.safeMin)
    if (body.safeMax !== undefined) data.safeMax = body.safeMax === null || body.safeMax === '' ? null : Number(body.safeMax)
    if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder)

    const unit = await prisma.tempUnit.update({ where: { id: params.id }, data })

    return NextResponse.json({
      id: unit.id,
      name: unit.name,
      type: unit.type,
      safeMin: num(unit.safeMin),
      safeMax: num(unit.safeMax),
      revenueCenterId: unit.revenueCenterId,
      sortOrder: unit.sortOrder,
    })
  } catch (err) {
    console.error('[temps/units PATCH]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── DELETE /api/temps/units/[id] ──────────────────────────────────────────────
// Soft delete — readings stay in the History record.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    await prisma.tempUnit.update({ where: { id: params.id }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[temps/units DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
