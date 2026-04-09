import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const { name } = await req.json()
  const area = await prisma.storageArea.update({ where: { id: params.id }, data: { name } })
  return NextResponse.json(area)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  // Unlink items first
  await prisma.inventoryItem.updateMany({ where: { storageAreaId: params.id }, data: { storageAreaId: null } })
  await prisma.storageArea.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
