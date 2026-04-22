import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  // Strip non-updatable fields; aliases handled via sub-routes
  const { id, _count, inventory, createdAt, aliases, invoiceSessions, monthSpend, prevMonthSpend, invoiceCount, ...data } = body
  const supplier = await prisma.supplier.update({
    where: { id: params.id },
    data,
    include: { aliases: { select: { id: true, name: true } } },
  })
  return NextResponse.json(supplier)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.inventoryItem.updateMany({ where: { supplierId: params.id }, data: { supplierId: null } })
  await prisma.supplier.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
