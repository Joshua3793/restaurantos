import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

async function guardAdmin(): Promise<NextResponse | null> {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  return null
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await guardAdmin()
  if (denied) return denied
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
  const denied = await guardAdmin()
  if (denied) return denied
  const supplier = await prisma.supplier.findUnique({ where: { id: params.id }, select: { id: true, name: true } })
  if (!supplier) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Every supplier box links to its supplier (NOT NULL, RESTRICT): a supplier
  // with boxes cannot be deleted. Say which, instead of a database error.
  const boxes = await prisma.inventorySupplierPrice.count({ where: { supplierId: params.id } })
  if (boxes > 0) {
    return NextResponse.json({ error: `${supplier.name} still has ${boxes} supplier boxes. Merge or remove those items' boxes first.` }, { status: 409 })
  }
  // The retired InventoryItem.supplierId copy still carries a foreign key until
  // Stage 1e drops it: clear any old value so the delete is not refused.
  await prisma.inventoryItem.updateMany({ where: { supplierId: params.id }, data: { supplierId: null } })
  await prisma.supplier.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
