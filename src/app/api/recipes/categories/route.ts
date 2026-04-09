import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const cats = await prisma.recipeCategory.findMany({
    orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { recipes: true } } },
  })
  return NextResponse.json(cats)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { name, type, color } = body
  if (!name || !type) return NextResponse.json({ error: 'name and type required' }, { status: 400 })

  const maxOrder = await prisma.recipeCategory.aggregate({
    where: { type },
    _max: { sortOrder: true },
  })
  const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1

  const cat = await prisma.recipeCategory.create({ data: { name, type, color: color || null, sortOrder } })
  return NextResponse.json(cat, { status: 201 })
}
