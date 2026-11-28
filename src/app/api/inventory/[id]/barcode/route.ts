import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { atLeast } from '@/lib/roles'
import { normalizeBarcode, barcodeVariants } from '@/lib/barcode'

// Mutating handlers must never be statically prerendered.
export const dynamic = 'force-dynamic'

/**
 * POST /api/inventory/[id]/barcode { barcode }
 *
 * Links a scanned barcode to an item. Any signed-in cook may give a barcode to
 * an item that has none (that is how the shelf gets learned during a count);
 * swapping an item's existing, different barcode is MANAGER+. A barcode that
 * already belongs to another active item — in any spelling (UPC-A ↔ EAN-13)
 * — is refused (409) with that item's name, so the cook can tell which one is
 * wrong. Only active, bought items take a barcode: an inactive item or a PREP
 * recipe's output is refused (400), the same set the scan lookup searches.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => null) as { barcode?: unknown } | null
  const barcode = normalizeBarcode(body?.barcode)
  if (!barcode) {
    return NextResponse.json({ error: 'A barcode is 6 to 32 letters, numbers or dashes.' }, { status: 400 })
  }

  const item = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    select: { id: true, itemName: true, barcode: true, isActive: true, recipe: { select: { type: true } } },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!item.isActive) {
    return NextResponse.json({ error: `${item.itemName} is switched off. Switch it on before giving it a barcode.` }, { status: 400 })
  }
  if (item.recipe?.type === 'PREP') {
    return NextResponse.json({ error: `${item.itemName} is made in the kitchen, so it can't have a barcode.` }, { status: 400 })
  }

  // Already linked to this exact code — nothing to do.
  if (item.barcode === barcode) {
    return NextResponse.json({ id: item.id, itemName: item.itemName, barcode })
  }

  if (item.barcode && !atLeast(user.role, 'MANAGER')) {
    return NextResponse.json(
      { error: `${item.itemName} already has a different barcode. Ask a manager to change it.` },
      { status: 403 },
    )
  }

  const other = await prisma.inventoryItem.findFirst({
    where: { barcode: { in: barcodeVariants(barcode) }, isActive: true, NOT: [{ id: item.id }, { recipe: { type: 'PREP' } }] },
    select: { id: true, itemName: true },
  })
  if (other) {
    return NextResponse.json(
      { error: `That barcode is already on ${other.itemName}.`, itemId: other.id, itemName: other.itemName },
      { status: 409 },
    )
  }

  const updated = await prisma.inventoryItem.update({
    where: { id: item.id },
    data: { barcode },
    select: { id: true, itemName: true, barcode: true },
  })
  return NextResponse.json(updated)
}
