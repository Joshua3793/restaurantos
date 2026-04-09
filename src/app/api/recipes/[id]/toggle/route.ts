import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(_req: NextRequest, { params }: { params: { id: string } }) {
  const recipe = await prisma.recipe.findUnique({ where: { id: params.id }, select: { isActive: true } })
  if (!recipe) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updated = await prisma.recipe.update({
    where: { id: params.id },
    data: { isActive: !recipe.isActive },
    select: { id: true, isActive: true },
  })
  return NextResponse.json(updated)
}
