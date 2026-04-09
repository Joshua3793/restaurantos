import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const suppliers = await prisma.supplier.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { inventory: true } } },
  })
  return NextResponse.json(suppliers)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const supplier = await prisma.supplier.create({ data: body })
  return NextResponse.json(supplier, { status: 201 })
}
