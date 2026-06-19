// src/lib/primary-offer.ts
//
// The primary-offer invariant: an InventoryItem with ≥1 InventorySupplierPrice
// row has EXACTLY ONE row with isPrimary=true, and the item's packChain/pricing
// (the $ spine) equal that primary offer's. The item's dimension/baseUnit (its
// physical identity) never change with supplier; only the pack FORMAT + price do.
//
// Items with NO offers (PREP-linked, manual, non-stocked) keep authoring their
// own item.pricing — every helper here is a no-op for them.

import { prisma } from '@/lib/prisma'
import {
  asChainItem, pricePerBaseUnit, levelBaseUnits, dimensionOf,
  type PackLink, type Pricing,
} from '@/lib/item-model'

// Minimal client surface so callers can pass either `prisma` or a tx client.
type Db = Pick<typeof prisma, 'inventoryItem' | 'inventorySupplierPrice'>

export interface SyncResult {
  changed: boolean
  oldPpb: number
  newPpb: number
}

/** The price implied by an offer's pricing, for the legacy item.purchasePrice column. */
function purchasePriceFromPricing(pricing: Pricing): number {
  return pricing.mode === 'RATE' ? Number(pricing.rate || 0) : Number(pricing.purchasePrice || 0)
}

/**
 * Guarantee the item has exactly one primary offer when it has offers.
 * If none (or >1) is primary, promote the most-recently-updated offer.
 * No-op for items with no offers. Returns the primary offer id, or null.
 */
export async function ensurePrimary(itemId: string, db: Db = prisma): Promise<string | null> {
  const offers = await db.inventorySupplierPrice.findMany({
    where: { inventoryItemId: itemId },
    select: { id: true, isPrimary: true },
    orderBy: { lastUpdated: 'desc' },
  })
  if (offers.length === 0) return null
  const primaries = offers.filter((o) => o.isPrimary)
  if (primaries.length === 1) return primaries[0].id
  // none, or more than one: promote the most-recently-updated, clear the rest.
  const winner = offers[0].id
  await db.inventorySupplierPrice.updateMany({
    where: { inventoryItemId: itemId },
    data: { isPrimary: false },
  })
  await db.inventorySupplierPrice.update({ where: { id: winner }, data: { isPrimary: true } })
  return winner
}

/**
 * Write the primary offer's packChain + pricing onto the item (the $ spine).
 * Preserves the item's dimension/baseUnit; re-validates countUnit against the
 * adopted chain and falls back to the base unit if it is no longer a chain level.
 * Never writes a zero/non-finite ppb (that would silently zero every recipe cost).
 * No-op for items with no offers. Returns the ppb delta so callers can fire alerts.
 */
export async function syncPrimaryOfferToItem(itemId: string, db: Db = prisma): Promise<SyncResult> {
  const item = await db.inventoryItem.findUnique({
    where: { id: itemId },
    select: { dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true },
  })
  if (!item) return { changed: false, oldPpb: 0, newPpb: 0 }
  const oldPpb = pricePerBaseUnit(asChainItem(item))

  const primary = await db.inventorySupplierPrice.findFirst({
    where: { inventoryItemId: itemId, isPrimary: true },
    select: { packChain: true, pricing: true },
  })
  // No usable primary offer → leave the item's own spine untouched.
  if (!primary || !Array.isArray(primary.packChain) || !primary.pricing) {
    return { changed: false, oldPpb, newPpb: oldPpb }
  }

  const newChain = primary.packChain as PackLink[]
  const newPricing = primary.pricing as Pricing
  const newPpb = pricePerBaseUnit({
    dimension: item.dimension as 'MASS' | 'VOLUME' | 'COUNT',
    baseUnit: item.baseUnit,
    packChain: newChain,
    pricing: newPricing,
  })
  if (!Number.isFinite(newPpb) || newPpb <= 0) {
    return { changed: false, oldPpb, newPpb: oldPpb }
  }

  // Re-validate countUnit against the adopted chain.
  const levels = levelBaseUnits(newChain)
  let countUnit = item.countUnit ?? 'each'
  const stillValid = countUnit in levels || dimensionOf(countUnit) === item.dimension
  if (!stillValid) countUnit = item.baseUnit

  await db.inventoryItem.update({
    where: { id: itemId },
    data: {
      packChain: newChain as unknown as object,
      pricing: newPricing as unknown as object,
      purchasePrice: purchasePriceFromPricing(newPricing),
      countUnit,
      lastUpdated: new Date(),
    },
  })
  return { changed: Math.abs(newPpb - oldPpb) > 1e-9, oldPpb, newPpb }
}

/** Make `offerId` the primary (clearing siblings) then sync the item spine. */
export async function setPrimaryOffer(itemId: string, offerId: string, db: Db = prisma): Promise<SyncResult> {
  await db.inventorySupplierPrice.updateMany({
    where: { inventoryItemId: itemId },
    data: { isPrimary: false },
  })
  await db.inventorySupplierPrice.update({ where: { id: offerId }, data: { isPrimary: true } })
  return syncPrimaryOfferToItem(itemId, db)
}

/**
 * After a manual item edit, mirror the item's chain+pricing onto the primary
 * offer so the invariant (item == primary offer) holds. No-op when no primary.
 */
export async function mirrorItemToPrimaryOffer(itemId: string, db: Db = prisma): Promise<void> {
  const primary = await db.inventorySupplierPrice.findFirst({
    where: { inventoryItemId: itemId, isPrimary: true },
    select: { id: true },
  })
  if (!primary) return
  const item = await db.inventoryItem.findUnique({
    where: { id: itemId },
    select: { packChain: true, pricing: true, purchasePrice: true },
  })
  if (!item) return
  await db.inventorySupplierPrice.update({
    where: { id: primary.id },
    data: {
      // The legacy `pricePerBaseUnit` column is intentionally NOT maintained here:
      // every reader derives ppb from packChain+pricing (offerPricePerBase), so the
      // chain/pricing we write below is the source of truth and the column is fallback-only.
      packChain: item.packChain as unknown as object,
      pricing: item.pricing as unknown as object,
      lastPrice: item.purchasePrice,
      lastUpdated: new Date(),
    },
  })
}
