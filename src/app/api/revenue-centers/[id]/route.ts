import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { RC_COLORS } from '@/lib/rc-colors'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const rc = await prisma.revenueCenter.findUnique({ where: { id: params.id } })
  if (!rc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(rc)
}

const RC_TYPES = ['restaurant', 'catering', 'events', 'retail', 'other'] as const

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}))
  const { name, color, isDefault, isActive, type, description, managerName, targetFoodCostPct, notes } = body

  const existing = await prisma.revenueCenter.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const resolvedColor = color !== undefined
    ? (RC_COLORS.includes(color) ? color : existing.color)
    : undefined
  const resolvedType = type !== undefined
    ? (RC_TYPES.includes(type) ? type : existing.type)
    : undefined

  const rc = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.revenueCenter.updateMany({ data: { isDefault: false } })
    }
    return tx.revenueCenter.update({
      where: { id: params.id },
      data: {
        ...(name?.trim()             ? { name: name.trim() }                                   : {}),
        ...(resolvedColor !== undefined ? { color: resolvedColor }                             : {}),
        ...(isDefault !== undefined  ? { isDefault: !!isDefault }                              : {}),
        ...(isActive  !== undefined  ? { isActive:  !!isActive  }                              : {}),
        ...(resolvedType !== undefined ? { type: resolvedType }                                : {}),
        ...(description  !== undefined ? { description:       description       || null }      : {}),
        ...(managerName  !== undefined ? { managerName:       managerName       || null }      : {}),
        ...(targetFoodCostPct !== undefined ? { targetFoodCostPct: targetFoodCostPct != null ? parseFloat(targetFoodCostPct) : null } : {}),
        ...(notes !== undefined      ? { notes: notes || null }                                : {}),
      },
    })
  })

  return NextResponse.json(rc)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const rc = await prisma.revenueCenter.findUnique({ where: { id: params.id } })
  if (!rc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (rc.isDefault) {
    return NextResponse.json({ error: 'Cannot delete the default revenue center' }, { status: 400 })
  }

  // Block delete if RC has linked data
  const [invoiceCount, salesCount, wastageCount, countCount] = await Promise.all([
    prisma.invoiceSession.count({ where: { revenueCenterId: params.id } }),
    prisma.salesEntry.count({ where: { revenueCenterId: params.id } }),
    prisma.wastageLog.count({ where: { revenueCenterId: params.id } }),
    prisma.countSession.count({ where: { revenueCenterId: params.id } }),
  ])

  if (invoiceCount + salesCount + wastageCount + countCount > 0) {
    return NextResponse.json({
      error: 'Cannot delete: this revenue center has linked invoices, sales, wastage, or count sessions.',
    }, { status: 400 })
  }

  await prisma.revenueCenter.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
