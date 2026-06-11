import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type  = searchParams.get('type') || ''
  const rcId  = searchParams.get('rcId') || ''

  // MENU: strict per-RC. PREP: shared (null) + active RC shown together. No rcId = All RCs.
  const rcFilter = !rcId
    ? {} // All RCs: return all categories of this type
    : type === 'MENU'
      ? { revenueCenterId: rcId }
      : { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } // PREP

  const cats = await prisma.recipeCategory.findMany({
    where: {
      ...(type ? { type } : {}),
      ...rcFilter,
    },
    orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { recipes: true } } },
  })
  return NextResponse.json(cats)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { name, type, color, revenueCenterId } = body
  if (!name || !type) return NextResponse.json({ error: 'name and type required' }, { status: 400 })

  const maxOrder = await prisma.recipeCategory.aggregate({
    where: { type, ...(revenueCenterId ? { revenueCenterId } : {}) },
    _max: { sortOrder: true },
  })
  const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1

  const cat = await prisma.recipeCategory.create({
    data: {
      name,
      type,
      color: color || null,
      sortOrder,
      revenueCenterId: revenueCenterId || null,
    },
  })
  return NextResponse.json(cat, { status: 201 })
}
