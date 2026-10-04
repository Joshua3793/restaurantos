import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { ITEM_NOT_FOUND } from '@/lib/box-rules'

export const dynamic = 'force-dynamic'

// GET /api/inventory/[id]/aliases — the wordings each supplier prints for this
// item on its invoices (ItemSupplierAlias rows, learned on approve). Drawer data
// for managers (W7): MANAGER+, a LEAD sees none of it. The client groups the
// rows by supplier; they arrive supplier by supplier, most recently seen first.
// → { aliases: [{ id, supplierId, supplierName, rawText, supplierItemCode, packLabel, useCount, lastUsed }] }

/** The learned purchase format as people write it ("4 × 2.5 kg"); "—" unless
 *  all three parts are known. Display only — costing never reads it. */
function packLabel(a: { packQty: unknown; packSize: unknown; packUOM: string | null }): string {
  if (a.packQty == null || a.packSize == null || !a.packUOM) return '—'
  return `${Number(a.packQty)} × ${Number(a.packSize)} ${a.packUOM}`
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const item = await prisma.inventoryItem.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!item) return NextResponse.json(ITEM_NOT_FOUND, { status: 404 })

  const rows = await prisma.itemSupplierAlias.findMany({
    where: { inventoryItemId: params.id },
    select: {
      id: true, supplierId: true, rawText: true, supplierItemCode: true,
      packQty: true, packSize: true, packUOM: true, useCount: true, lastUsed: true,
      supplier: { select: { name: true } },
    },
    orderBy: [{ supplier: { name: 'asc' } }, { lastUsed: 'desc' }],
  })

  return NextResponse.json({
    aliases: rows.map(a => ({
      id: a.id,
      supplierId: a.supplierId,
      supplierName: a.supplier.name,
      rawText: a.rawText,
      supplierItemCode: a.supplierItemCode,
      packLabel: packLabel(a),
      useCount: a.useCount,
      lastUsed: a.lastUsed,
    })),
  })
}
