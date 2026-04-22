import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// POST /api/suppliers/[id]/aliases — add a single alias
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { name } = await req.json()
  if (!name || !name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  try {
    const alias = await prisma.supplierAlias.create({
      data: { supplierId: params.id, name: name.trim() },
    })
    return NextResponse.json(alias, { status: 201 })
  } catch {
    // Unique constraint violation — alias already exists
    return NextResponse.json({ error: 'Alias already exists' }, { status: 409 })
  }
}
