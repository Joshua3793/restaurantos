// Money + edit gates for the inventory API. Every inventory route is callable by
// any signed-in user (the count page opens the item drawer for STAFF), so what a
// route RETURNS and what it lets a caller WRITE are gated here, separately from
// who may call it.
//
//   - Money: LEAD+ sees item prices (a Shift Lead browses the item library with
//     prices — /inventory is LEAD+ in route-access.ts). STAFF never does
//     (ROLE_DESCRIPTIONS in src/lib/roles.ts).
//   - Edits: MANAGER+. Below that the item drawer is view-only. A save from a
//     caller who was sent a nulled price would write that null back over the
//     real one, so the server refuses the edit rather than trusting the client.
//
// Money fields are NULLED, not deleted (same convention as count-redact.ts):
// readers fall back through `Number(x ?? …)`, so a null reads as 0, never NaN.
import type { Role } from '@prisma/client'
import { atLeast } from './roles'
import { nullKeys, redactItemMoney } from './count-redact'

/** LEAD+ sees item prices on inventory surfaces; STAFF never does. */
export function seesItemMoney(role: Role): boolean {
  return atLeast(role, 'LEAD')
}

/** MANAGER+ may create, edit, delete or re-price items and change their RC membership. */
export function canEditItems(role: Role): boolean {
  return atLeast(role, 'MANAGER')
}

/** Item money plus the 30-day average recipes are costed on. */
export const INVENTORY_ITEM_MONEY_KEYS = ['costBasis'] as const
/** A supplier offer's price, its derived $/base, and the price-volatility stats. */
// `lastPrice` is computed (offerListedPrice from pricing), not a column.
export const OFFER_MONEY_KEYS = ['lastPrice', 'pricePerBaseUnit', 'pricing', 'volatility', 'stability'] as const

/**
 * An inventory item as GET /api/inventory[/:id] returns it, minus every price.
 * Also clears the money carried by its relations: legacy invoice lines (unit
 * price, line total, invoice total) are dropped, and a linked recipe's menu
 * price is nulled. Quantities, units, the pack chain and the bridges stay.
 */
export function redactInventoryItem<T extends object>(item: T): T {
  const out = nullKeys(redactItemMoney(item), INVENTORY_ITEM_MONEY_KEYS) as Record<string, unknown>
  if (Array.isArray(out.invoiceLineItems)) out.invoiceLineItems = []
  if (Array.isArray(out.recipeIngredients)) {
    out.recipeIngredients = out.recipeIngredients.map(ri => {
      const r = ri as Record<string, unknown>
      return r.recipe && typeof r.recipe === 'object' ? { ...r, recipe: nullKeys(r.recipe as object, ['menuPrice']) } : r
    })
  }
  if (out.recipe && typeof out.recipe === 'object') out.recipe = nullKeys(out.recipe as object, ['menuPrice'])
  return out as T
}

/** A wastage log (GET/POST /api/wastage) minus its cost and its item's price. STAFF log
 *  waste (it's on their home screen) — they see what and how much, never what it cost. */
export function redactWastageLog<T extends object>(log: T): T {
  const out = nullKeys(log, ['costImpact']) as Record<string, unknown>
  if (out.inventoryItem && typeof out.inventoryItem === 'object') out.inventoryItem = redactInventoryItem(out.inventoryItem as object)
  return out as T
}

/** A supplier offer (GET /api/inventory/:id/suppliers) minus its price and price history. */
export function redactOffer<T extends object>(offer: T): T {
  const out = nullKeys(offer, OFFER_MONEY_KEYS) as Record<string, unknown>
  if (Array.isArray(out.history)) out.history = []
  return out as T
}
