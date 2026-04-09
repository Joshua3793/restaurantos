import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const areas = await prisma.storageArea.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { items: true } } },
  })
  return NextResponse.json(areas)
}

export async function POST(req: NextRequest) {
  const { name } = await req.json()
  const area = await prisma.storageArea.create({ data: { name } })
  return NextResponse.json(area, { status: 201 })
}
