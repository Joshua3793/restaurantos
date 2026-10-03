// Money redaction for the count API. STAFF and LEAD count stock; they "never see
// cost or money" (ROLE_DESCRIPTIONS in src/lib/roles.ts). The count routes are
// callable by every signed-in user, so what they RETURN has to be gated
// separately from who may call them — hiding the $ on screen is not enough.
//
// Money fields are set to null (not deleted): every reader already falls back
// through `Number(x ?? …)`, so a null reads as 0 — never NaN — and the shape of
// the response stays the same for every role. Quantities, units, pack chains
// and variancePct (a quantity ratio) are untouched — the page converts counts
// through packChain/baseUnit alone.
import type { Role } from '@prisma/client'
import { atLeast } from './roles'

/** MANAGER+ sees count money; below that, every $ field is nulled. */
export function seesCountMoney(role: Role): boolean {
  return atLeast(role, 'MANAGER')
}

export type Nulled<T, K extends PropertyKey> = { [P in keyof T]: P extends K ? T[P] | null : T[P] }

export function nullKeys<T extends object, K extends PropertyKey>(obj: T, keys: readonly K[]): Nulled<T, K> {
  const out = { ...obj } as Record<PropertyKey, unknown>
  for (const k of keys) if (k in out) out[k] = null
  return out as Nulled<T, K>
}

/** The item's price itself, the legacy purchase price, and the computed $/base. */
// `purchasePrice` is computed (listedPrice from pricing), not a column.
export const ITEM_MONEY_KEYS = ['pricing', 'purchasePrice', 'pricePerBaseUnit'] as const
/** The line's frozen price and its $ variance. */
export const LINE_MONEY_KEYS = ['priceAtCount', 'varianceCost'] as const
/** Value of the observed lines. */
export const SESSION_MONEY_KEYS = ['totalCountedValue'] as const
/** Per-area on-hand value and $ drift (GET /api/count/areas). */
export const AREA_MONEY_KEYS = ['onHandValue', 'drift'] as const
/** Finalize + report summaries. */
export const SUMMARY_MONEY_KEYS = ['totalValue', 'totalVarianceCost'] as const

export function redactItemMoney<T extends object>(item: T) {
  return nullKeys(item, ITEM_MONEY_KEYS)
}

export function redactLineMoney<T extends object>(line: T) {
  const out = nullKeys(line, LINE_MONEY_KEYS) as Record<string, unknown>
  if (out.inventoryItem && typeof out.inventoryItem === 'object') {
    out.inventoryItem = redactItemMoney(out.inventoryItem as object)
  }
  return out as Nulled<T, (typeof LINE_MONEY_KEYS)[number]>
}

export function redactSessionMoney<T extends object>(session: T) {
  const out = nullKeys(session, SESSION_MONEY_KEYS) as Record<string, unknown>
  if (Array.isArray(out.lines)) out.lines = out.lines.map(l => redactLineMoney(l as object))
  return out as Nulled<T, (typeof SESSION_MONEY_KEYS)[number]>
}

export function redactAreaMoney<T extends object>(area: T) {
  return nullKeys(area, AREA_MONEY_KEYS)
}

export function redactSummaryMoney<T extends object>(summary: T) {
  return nullKeys(summary, SUMMARY_MONEY_KEYS)
}
