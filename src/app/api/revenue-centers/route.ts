import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { RC_COLORS } from '@/lib/rc-colors'

// GET /api/revenue-centers — list all RCs; auto-seeds default if none exist
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

// POST /api/revenue-centers — create a new RC
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { name, color, isDefault } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const resolvedColor = RC_COLORS.includes(color) ? color : 'blue'

  const rc = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.revenueCenter.updateMany({ data: { isDefault: false } })
    }
    return tx.revenueCenter.create({
      data: { name: name.trim(), color: resolvedColor, isDefault: !!isDefault },
    })
  })

  return NextResponse.json(rc, { status: 201 })
}
