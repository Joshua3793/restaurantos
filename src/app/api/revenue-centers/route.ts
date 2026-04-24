import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { RC_COLORS } from '@/lib/rc-colors'

const RC_TYPES = ['restaurant', 'catering', 'events', 'retail', 'other'] as const

export async function GET() {
  let rcs = await prisma.revenueCenter.findMany({ orderBy: { createdAt: 'asc' } })

  if (rcs.length === 0) {
    const defaultRc = await prisma.revenueCenter.create({
      data: { name: 'Main Kitchen', color: 'blue', isDefault: true },
    })
    rcs = [defaultRc]
  }

  return NextResponse.json(rcs)
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { name, color, isDefault, isActive, type, description, managerName, targetFoodCostPct, notes } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const resolvedColor = RC_COLORS.includes(color) ? color : 'blue'
  const resolvedType  = RC_TYPES.includes(type)  ? type  : 'other'

  const rc = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.revenueCenter.updateMany({ data: { isDefault: false } })
    }
    return tx.revenueCenter.create({
      data: {
        name: name.trim(),
        color: resolvedColor,
        isDefault: !!isDefault,
        isActive:  isActive !== undefined ? !!isActive : true,
        type:      resolvedType,
        description:       description       || null,
        managerName:       managerName       || null,
        targetFoodCostPct: targetFoodCostPct != null ? parseFloat(targetFoodCostPct) : null,
        notes:             notes             || null,
      },
    })
  })

  return NextResponse.json(rc, { status: 201 })
}
