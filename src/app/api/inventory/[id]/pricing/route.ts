import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { DIMENSION_BASE, validateChainItem, asChainItem, eachMeasureOf, densityOf, type ChainItem, type Dimension } from '@/lib/item-model'
import { itemHistory, hasHistory } from '@/lib/item-history'
import { tombstonedRows, TOMBSTONE_EDIT_ERROR } from '@/lib/item-merge-rows'
import { postUpdate } from '@/lib/inventory-post-update'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'

export const dynamic = 'force-dynamic'

// PATCH /api/inventory/[id]/pricing — the item's OWN measure, pack and price.
// Only for an item with no supplier box: with a box, the price lives on the box
// (edit the box; the primary box is the item's price). The measure is locked
// once the item has history — Stage 2c's guided flow converts history with it.
async function handlePATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = (await req.json()) ?? {}
  if (!body.packChain || !body.pricing || !body.expectedLastUpdated) {
    return NextResponse.json({ error: 'Reload the item and try again.', code: 'BAD_FIELD' }, { status: 400 })
  }

  const before = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    select: {
      id: true, mergedIntoId: true, lastUpdated: true, dimension: true, baseUnit: true, countUnit: true,
      packChain: true, pricing: true,
      isStocked: true, eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true, allergens: true,
      recipe: { select: { id: true, name: true } },
    },
  })
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (tombstonedRows([before]).length)
    return NextResponse.json({ error: TOMBSTONE_EDIT_ERROR, code: 'TOMBSTONE' }, { status: 409 })

  // R8 — two people editing: the save names the version it was made from.
  if (new Date(body.expectedLastUpdated).getTime() !== before.lastUpdated.getTime()) {
    return NextResponse.json({
      error: 'Someone saved this item a moment ago. Reload to see their change before saving yours.',
      code: 'STALE',
    }, { status: 409 })
  }

  // A recipe-made item is priced by its recipe (recipe sync would overwrite it).
  if (before.recipe) {
    return NextResponse.json({
      error: `This item's price comes from its recipe "${before.recipe.name}".`,
      code: 'PREP_OWNED',
    }, { status: 409 })
  }

  // R3 — with a supplier box the price lives on the box, never on the item.
  const h = await itemHistory(params.id)
  if (h.offers > 0) {
    return NextResponse.json({
      error: "This item's price lives on its supplier box. Edit the box instead.",
      code: 'HAS_OFFERS',
    }, { status: 409 })
  }

  if (body.dimension !== undefined && !['MASS', 'VOLUME', 'COUNT'].includes(body.dimension)) {
    return NextResponse.json({ error: 'Reload the item and try again.', code: 'BAD_FIELD' }, { status: 400 })
  }

  // R4 — the measure is locked once anything is recorded in it.
  const dimension = (body.dimension ?? before.dimension) as Dimension
  if (dimension !== before.dimension && hasHistory(h)) {
    return NextResponse.json({
      error: "This item already has counts, deliveries or recipes in its current measure. Use 'Change how it's measured' to convert them together.",
      code: 'DIMENSION_LOCKED',
    }, { status: 409 })
  }

  // R5 — a stocked item cannot be $0.
  const countUnit = body.countUnit ?? before.countUnit
  const ci: ChainItem = {
    dimension, baseUnit: DIMENSION_BASE[dimension], packChain: body.packChain, pricing: body.pricing,
    countUnit, eachMeasure: eachMeasureOf(before), densityGPerMl: densityOf(before),
  }
  // Only the errors THIS save introduces: an item whose stored chain is already
  // invalid can still save a price change — but only while the chain it submits
  // IS the stored one. A changed chain is judged whole. A $0 price is never
  // excused, so an item that is $0 today cannot stay $0.
  const sameChain = JSON.stringify(body.packChain) === JSON.stringify(before.packChain)
  const stored = new Set(sameChain ? validateChainItem(asChainItem(before)) : [])
  const errors = validateChainItem(ci, { requirePositivePrice: before.isStocked })
    .filter(e => e === 'price must be above $0' || !stored.has(e))
  if (errors.length) {
    const zero = errors.includes('price must be above $0')
    return NextResponse.json({
      error: zero ? 'A stocked item needs a price above $0.' : errors.join('; '),
      code: zero ? 'ZERO_PRICE' : 'INVALID',
    }, { status: 400 })
  }

  // The write itself re-checks the version it read, closing the window between
  // the read-time STALE check and this update.
  const { count } = await prisma.inventoryItem.updateMany({
    where: { id: params.id, lastUpdated: before.lastUpdated },
    data: { dimension, baseUnit: ci.baseUnit, packChain: body.packChain, pricing: body.pricing, countUnit, lastUpdated: new Date() },
  })
  if (count === 0) {
    return NextResponse.json({
      error: 'Someone saved this item a moment ago. Reload to see their change before saving yours.',
      code: 'STALE',
    }, { status: 409 })
  }
  return await postUpdate(params.id, before.allergens ?? [], undefined)
}

// Stock-valuing writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const PATCH = invalidatesTheoretical(handlePATCH)
