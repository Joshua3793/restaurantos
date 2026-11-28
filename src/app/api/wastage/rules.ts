// Who may see waste money, and who may delete a waste entry. Pure — the routes and
// their tests share it.
//
//  - Money: MANAGER+ sees what waste cost. Below that a cook logs and sees the
//    amount, never the dollars (same convention as src/lib/count-redact.ts: money
//    fields are NULLED, not deleted, so readers' `Number(x ?? 0)` stays safe).
//  - Delete: the person who logged it, within 24 hours (an Undo, a wrong item); a
//    MANAGER+ any time. WastageLog stores the logger as a display name, not a user
//    id, so "the person who logged it" is the signed-in person's display name —
//    the same name the POST wrote (src/lib/checklists/who.ts displayName).
import type { Role } from '@prisma/client'
import { atLeast } from '@/lib/roles'
import { nullKeys } from '@/lib/count-redact'
import { loggedAtOf } from '@/components/wastage/logged-at'

export { loggedAtOf }

export function seesWasteMoney(role: Role): boolean {
  return atLeast(role, 'MANAGER')
}

export const WASTE_MONEY_KEYS = ['costImpact'] as const

/** The item fields a waste entry carries — no pricing, for every role. */
export const WASTE_ITEM_SELECT = { id: true, itemName: true, category: true, baseUnit: true } as const

export function redactWasteLog<T extends object>(log: T) {
  return nullKeys(log, WASTE_MONEY_KEYS)
}

export const OWN_DELETE_WINDOW_MS = 24 * 60 * 60 * 1000

export function canDeleteWaste(
  viewer: { role: Role; name: string },
  log: { id: string; date: Date | string; loggedBy: string },
  now: Date = new Date(),
): boolean {
  if (atLeast(viewer.role, 'MANAGER')) return true
  if (!viewer.name || log.loggedBy.trim() !== viewer.name.trim()) return false
  return now.getTime() - loggedAtOf(log, now).getTime() <= OWN_DELETE_WINDOW_MS
}
