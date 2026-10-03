import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { validateChainItem, dimensionOf, eachMeasureOf, densityOf, asChainItem } from '@/lib/item-model'
import { listedPrice, windowedAvgCost, withLastCost } from '@/lib/cost-basis'
import { PRIMARY_SUPPLIER_INCLUDE, withSupplier } from '@/lib/item-supplier'
import { postUpdate } from '@/lib/inventory-post-update'
import { itemHistory, hasHistory, bridgeUsedBy } from '@/lib/item-history'
import { tombstonedRows, TOMBSTONE_EDIT_ERROR } from '@/lib/item-merge-rows'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'
import { requireSession, AuthError } from '@/lib/auth'
import { seesItemMoney, redactInventoryItem } from '@/lib/inventory-redact'

// Mutating handlers must never be statically prerendered.
export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const item = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    include: {
      ...PRIMARY_SUPPLIER_INCLUDE,
      storageArea: true,
      invoiceLineItems: { include: { invoice: true } },
      recipeIngredients: { include: { recipe: true } },
      recipe: { select: { id: true, name: true, baseYieldQty: true, yieldUnit: true } },
    },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Populate a computed `pricePerBaseUnit` so the InventoryItemDrawer / recipes
  // PREP modal keep reading it after the legacy column is dropped. costBasis is
  // null for a PREP-linked item — windowedAvgCost never averages those (its cost
  // comes from the recipe, not invoice receipts).
  const costBasis = item.recipe ? null : (await windowedAvgCost([item.id])).get(item.id) ?? null
  // The edit rules the drawer needs up front: whether a measure change would
  // rewrite history, how many supplier boxes there are, and which recipes cost
  // only through the each-measure bridge.
  const [h, usedBy] = await Promise.all([itemHistory(item.id), bridgeUsedBy(item.id)])
  const body = {
    ...withLastCost(withSupplier(item)), purchasePrice: listedPrice(item), costBasis,
    hasHistory: hasHistory(h), offerCount: h.offers, bridgeUsedBy: usedBy,
  }
  // STAFF opens this drawer from the count page — quantities and units only.
  return NextResponse.json(seesItemMoney(user.role) ? body : redactInventoryItem(body))
}

/** R1 — the only keys an item edit may carry. What the item IS (dimension,
 *  chain) and what it costs (pricing) are not edited here; stock moves only
 *  through counts, receipts, wastage and transfers. */
const EDITABLE = [
  'itemName', 'category', 'storageAreaId', 'isActive', 'isStocked', 'allergens', 'barcode',
  'countUnit', 'eachMeasureQty', 'eachMeasureUnit', 'densityGPerMl', 'expectedLastUpdated',
] as const

async function handlePUT(req: NextRequest, { params }: { params: { id: string } }) {
  // Item edits are MANAGER+ (src/lib/inventory-redact.ts canEditItems). The
  // role gate runs before the body is read, so a STAFF/LEAD save is always 403.
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'
  const body = (await req.json()) ?? {}

  // R1 — an allow-list, never a spread. Any other key is refused, not ignored.
  const bad = Object.keys(body).filter(k => !(EDITABLE as readonly string[]).includes(k))
  if (bad.length) {
    return NextResponse.json({ error: "That field can't be changed here.", code: 'BAD_FIELD', fields: bad }, { status: 400 })
  }
  if (!body.expectedLastUpdated || Number.isNaN(new Date(body.expectedLastUpdated).getTime())) {
    return NextResponse.json({ error: 'Reload the item and try again.', code: 'BAD_FIELD', fields: ['expectedLastUpdated'] }, { status: 400 })
  }
  // Input hygiene — a present-but-unusable value is refused, never stored.
  if ('countUnit' in body && (typeof body.countUnit !== 'string' || !body.countUnit.trim())) {
    return NextResponse.json({ error: 'Pick a count unit.', code: 'BAD_FIELD', fields: ['countUnit'] }, { status: 400 })
  }
  if ('itemName' in body && (typeof body.itemName !== 'string' || !body.itemName.trim())) {
    return NextResponse.json({ error: 'The item needs a name.', code: 'BAD_FIELD', fields: ['itemName'] }, { status: 400 })
  }
  if ('allergens' in body && !Array.isArray(body.allergens)) {
    return NextResponse.json({ error: 'Allergens must be a list.', code: 'BAD_FIELD', fields: ['allergens'] }, { status: 400 })
  }
  const { countUnit, eachMeasureQty, eachMeasureUnit, densityGPerMl } = body

  const before = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    select: {
      id: true, itemName: true, allergens: true, countUnit: true, mergedIntoId: true, lastUpdated: true,
      dimension: true, baseUnit: true, packChain: true, pricing: true,
      eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true,
      recipe: { select: { id: true, name: true } },
    },
  })
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // A merge tombstone is off-limits to the ordinary edit path: an edit here can
  // set isActive true, which is exactly the state undo refuses to replay onto.
  if (tombstonedRows([before]).length)
    return NextResponse.json({ error: TOMBSTONE_EDIT_ERROR, code: 'TOMBSTONE' }, { status: 409 })

  // R8 — two people editing: the save names the version it was made from.
  if (new Date(body.expectedLastUpdated).getTime() !== before.lastUpdated.getTime()) {
    return NextResponse.json({
      error: 'Someone saved this item a moment ago. Reload to see their change before saving yours.',
      code: 'STALE',
    }, { status: 409 })
  }

  // R6 — a recipe-made item is named, allergened and count-united by its recipe
  // (recipe sync would overwrite the edit anyway). Sending the same value back
  // is not a change.
  if (before.recipe) {
    const changed = (k: 'itemName' | 'countUnit') => k in body && body[k] !== before[k]
    const allergensChanged = 'allergens' in body
      && JSON.stringify([...(body.allergens ?? [])].sort()) !== JSON.stringify([...(before.allergens ?? [])].sort())
    if (changed('itemName') || changed('countUnit') || allergensChanged) {
      return NextResponse.json({
        error: `This item is made from the recipe "${before.recipe.name}". Change its name, allergens or count unit in the recipe.`,
        code: 'PREP_OWNED',
      }, { status: 409 })
    }
  }

  // ── Bridge fields ───────────────────────────────────────────────────────────
  // Both bridges are PATCH-shaped: a key that isn't in the body is left alone
  // (so saving a density can't wipe an each-measure), a key that is present with
  // an empty/zero value clears it. A positive quantity with a unit that can't
  // express the bridge is a 400 — silently storing null there is what made a
  // saved bridge look like it did nothing.
  const hasEachMeasure = 'eachMeasureQty' in body || 'eachMeasureUnit' in body
  const emQty = Number(eachMeasureQty)
  const emUnit = eachMeasureUnit ? String(eachMeasureUnit).trim().toLowerCase() : ''
  if (hasEachMeasure && emQty > 0 && (!emUnit || dimensionOf(emUnit) === 'COUNT')) {
    return NextResponse.json({
      error: `"${emUnit || eachMeasureUnit}" can't measure the bridge — use a weight or volume unit.`,
    }, { status: 400 })
  }
  const emValid = emQty > 0 && !!emUnit && dimensionOf(emUnit) !== 'COUNT'
  const hasDensity = 'densityGPerMl' in body
  const nextDensity = hasDensity
    ? (Number(densityGPerMl) > 0 ? Number(densityGPerMl) : null)
    : densityOf(before)

  // Validate against the STORED chain/pricing/dimension (this route never
  // changes them) with the incoming count unit and the EFFECTIVE bridges this
  // save ends up with — a bridged RATE prices only through its bridge, so
  // clearing that bridge 400s here (see rateIsCostable in item-model.ts).
  const ci = asChainItem({
    ...before,
    countUnit: countUnit ?? before.countUnit,
    eachMeasureQty: hasEachMeasure ? (emValid ? emQty : null) : before.eachMeasureQty,
    eachMeasureUnit: hasEachMeasure ? (emValid ? emUnit : null) : before.eachMeasureUnit,
    densityGPerMl: nextDensity,
  })
  // Only the errors THIS save introduces: an item whose stored chain is already
  // invalid (writers like invoice approve / prep sync never ran the validator)
  // must still be able to save a name, an allergen or a deactivation.
  const stored = new Set(validateChainItem(asChainItem(before)))
  const errors = validateChainItem(ci).filter(e => !stored.has(e))
  if (errors.length) return NextResponse.json({ error: errors.join('; ') }, { status: 400 })

  // R7 — before the drawer clears an each-measure it asks which recipes cost
  // through it (they read $0 the moment it goes). Nothing is written.
  if (dryRun) {
    const clearingBridge = hasEachMeasure && !emValid && eachMeasureOf(before) !== null
    return NextResponse.json({ ok: true, bridgeUsedBy: clearingBridge ? await bridgeUsedBy(params.id) : [] })
  }

  const data: Prisma.InventoryItemUncheckedUpdateInput = { lastUpdated: new Date() }
  for (const k of ['itemName', 'category', 'isActive', 'isStocked', 'allergens', 'barcode', 'countUnit'] as const) {
    if (k in body) (data as Record<string, unknown>)[k] = body[k]
  }
  if ('storageAreaId' in body) data.storageAreaId = body.storageAreaId || null
  // Count↔weight bridge ("1 each = N g/ml", valid in either direction) and the
  // weight↔volume density bridge. Neither changes the item's dimension, chain
  // or stock.
  if (hasEachMeasure) {
    data.eachMeasureQty = emValid ? emQty : null
    data.eachMeasureUnit = emValid ? emUnit : null
  }
  if (hasDensity) data.densityGPerMl = nextDensity
  // The write itself re-checks the version it read, closing the window between
  // the read-time STALE check and this update.
  const { count } = await prisma.inventoryItem.updateMany({ where: { id: params.id, lastUpdated: before.lastUpdated }, data })
  if (count === 0) {
    return NextResponse.json({
      error: 'Someone saved this item a moment ago. Reload to see their change before saving yours.',
      code: 'STALE',
    }, { status: 409 })
  }

  return await postUpdate(params.id, before.allergens ?? [], body.allergens)
}

async function handleDELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  // Item edits are MANAGER+ (src/lib/inventory-redact.ts canEditItems).
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const id = params.id

  const item = await prisma.inventoryItem.findUnique({ where: { id }, select: { id: true, mergedIntoId: true } })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Hard-deleting a tombstone would leave its merge un-undoable (undo restores
  // rows onto this very id) — and the blocker list below can't see it, because a
  // merge moved every referencing row onto the survivor.
  if (tombstonedRows([item]).length)
    return NextResponse.json({ error: TOMBSTONE_EDIT_ERROR, blocked: true }, { status: 409 })

  // Block the hard delete when the item carries real usage/history. Deleting it
  // would either violate a FK (Restrict) or destroy costing/financial history that
  // the pricePerBaseUnit spine depends on. Tell the caller to deactivate instead.
  const [
    recipeUses, linkedRecipe, invoiceLines, countLines,
    snapshots, wastageLogs, stockTransfers, prepItems,
  ] = await Promise.all([
    prisma.recipeIngredient.count({ where: { inventoryItemId: id } }),
    prisma.recipe.count({ where: { inventoryItemId: id } }),
    prisma.invoiceLineItem.count({ where: { inventoryItemId: id } }),
    prisma.countLine.count({ where: { inventoryItemId: id } }),
    prisma.inventorySnapshot.count({ where: { inventoryItemId: id } }),
    prisma.wastageLog.count({ where: { inventoryItemId: id } }),
    prisma.stockTransfer.count({ where: { inventoryItemId: id } }),
    prisma.prepItem.count({ where: { linkedInventoryItemId: id } }),
  ])

  const blockers: string[] = []
  if (recipeUses)     blockers.push(`used in ${recipeUses} recipe ingredient${recipeUses > 1 ? 's' : ''}`)
  if (linkedRecipe)   blockers.push(`the output of a prep recipe`)
  if (invoiceLines)   blockers.push(`on ${invoiceLines} invoice line${invoiceLines > 1 ? 's' : ''}`)
  if (countLines)     blockers.push(`in ${countLines} stock count${countLines > 1 ? 's' : ''}`)
  if (snapshots)      blockers.push(`in ${snapshots} count snapshot${snapshots > 1 ? 's' : ''}`)
  if (wastageLogs)    blockers.push(`in ${wastageLogs} wastage log${wastageLogs > 1 ? 's' : ''}`)
  if (stockTransfers) blockers.push(`in ${stockTransfers} stock transfer${stockTransfers > 1 ? 's' : ''}`)
  if (prepItems)      blockers.push(`linked to ${prepItems} prep item${prepItems > 1 ? 's' : ''}`)

  if (blockers.length) {
    return NextResponse.json(
      {
        error: `Can't delete — this item is ${blockers.join(', ')}. Deactivate it instead to hide it without losing history.`,
        blocked: true,
        canDeactivate: true,
      },
      { status: 409 },
    )
  }

  // Truly unreferenced — safe to hard-delete. Clean up the metadata-only relations
  // (match rules / scan matches / price alerts) that would otherwise FK-block it.
  // StockAllocation + InventorySupplierPrice cascade automatically.
  try {
    await prisma.$transaction(async tx => {
      await tx.invoiceMatchRule.deleteMany({ where: { inventoryItemId: id } })
      await tx.priceAlert.deleteMany({ where: { inventoryItemId: id } })
      await tx.invoiceScanItem.updateMany({ where: { matchedItemId: id }, data: { matchedItemId: null } })
      await tx.inventoryItem.delete({ where: { id } })
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/inventory/:id]', err)
    return NextResponse.json({ error: 'Failed to delete item' }, { status: 500 })
  }
}

// Stock-moving writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const PUT = invalidatesTheoretical(handlePUT)
export const DELETE = invalidatesTheoretical(handleDELETE)
