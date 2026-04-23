import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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
  const { name, color, isDefault } = await req.json()

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  if (isDefault) {
    await prisma.revenueCenter.updateMany({ data: { isDefault: false } })
  }

  const rc = await prisma.revenueCenter.create({
    data: { name: name.trim(), color: color || 'blue', isDefault: !!isDefault },
  })

  return NextResponse.json(rc, { status: 201 })
}
