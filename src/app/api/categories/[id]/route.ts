import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const { name } = await req.json()
  if (!name?.trim()) return NextResponse.json({ error: 'Name required' }, { status: 400 })
  const cat = await prisma.category.update({
    where: { id: params.id },
    data: { name: name.trim().toUpperCase() },
  })
  return NextResponse.json(cat)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.category.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
