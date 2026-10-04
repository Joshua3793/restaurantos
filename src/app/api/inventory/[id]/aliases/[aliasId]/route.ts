import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { itemRefusal, ITEM_NOT_FOUND } from '@/lib/box-rules'

export const dynamic = 'force-dynamic'

// DELETE /api/inventory/[id]/aliases/[aliasId] — forget one supplier wording of
// this item (W7, MANAGER+). The next invoice from that supplier with that
// wording needs matching again; approving it learns the wording afresh.
// Nothing else moves: no price, no stock, no box. → { ok: true }

const ALIAS_GONE = { error: 'That wording is no longer there. Reload the item.', code: 'NOT_FOUND' } as const

type Ctx = { params: { id: string; aliasId: string } }

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const item = await prisma.inventoryItem.findUnique({
    where: { id: params.id }, select: { id: true, mergedIntoId: true, recipe: { select: { id: true } } },
  })
  if (!item) return NextResponse.json(ITEM_NOT_FOUND, { status: 404 })
  // A merged-away item is read-only. (A recipe-made item has no boxes, but a
  // wording learned for it may still be forgotten — only the tombstone refuses.)
  const refused = itemRefusal(item)
  if (refused?.code === 'TOMBSTONE') return NextResponse.json(refused, { status: 409 })

  const alias = await prisma.itemSupplierAlias.findFirst({
    where: { id: params.aliasId, inventoryItemId: params.id }, select: { id: true },
  })
  if (!alias) return NextResponse.json(ALIAS_GONE, { status: 404 })

  // Scoped to the item again, so a wording re-pointed by a merge meanwhile is left alone.
  const { count } = await prisma.itemSupplierAlias.deleteMany({
    where: { id: params.aliasId, inventoryItemId: params.id },
  })
  if (count === 0) return NextResponse.json(ALIAS_GONE, { status: 404 })
  return NextResponse.json({ ok: true })
}
