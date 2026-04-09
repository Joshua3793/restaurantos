import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { name, color, sortOrder } = body

  const cat = await prisma.recipeCategory.update({
    where: { id: params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    },
    include: { _count: { select: { recipes: true } } },
  })
  return NextResponse.json(cat)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const cat = await prisma.recipeCategory.findUnique({
    where: { id: params.id },
    include: { _count: { select: { recipes: true } } },
  })
  if (!cat) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (cat._count.recipes > 0) {
    return NextResponse.json({ error: 'Move recipes to another category first' }, { status: 400 })
  }
  await prisma.recipeCategory.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
