import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'
import { requireSession, AuthError } from '@/lib/auth'
import { seesItemMoney, redactInventoryItem } from '@/lib/inventory-redact'

// Mutating handlers must never be statically prerendered.
export const dynamic = 'force-dynamic'

// Marks the item counted at its current on-hand — a count action, which STAFF run.
async function handlePOST(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const item = await prisma.inventoryItem.findUnique({ where: { id: params.id } })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updated = await prisma.inventoryItem.update({
    where: { id: params.id },
    data: { lastCountDate: new Date(), lastCountQty: item.stockOnHand },
  })
  return NextResponse.json(seesItemMoney(user.role) ? updated : redactInventoryItem(updated))
}

// Stock-moving writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const POST = invalidatesTheoretical(handlePOST)
