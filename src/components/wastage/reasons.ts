// Wastage reasons in plain words. `WastageLog.reason` is a plain String column, so
// the stored CODES stay exactly what reports, signals and the movement track already
// read (SPOILAGE, PREP_TRIM, …); only the words a cook sees change. COMP is the one
// new code (a dish sent back or comped) — the old list had nowhere to put it.
//
// Pure and server-safe: the POST route checks a reason against WASTE_REASON_CODES.

export interface WasteReason { code: string; label: string; hint: string }

/** The big buttons on the phone form, in the order a cook reaches for them. */
export const PICK_REASONS: readonly WasteReason[] = [
  { code: 'PREP_TRIM',      label: 'Trim',              hint: 'Peel, bones, offcuts' },
  { code: 'SPOILAGE',       label: 'Spoiled',           hint: 'Gone off, out of date' },
  { code: 'DROPPED',        label: 'Dropped / mistake', hint: 'Dropped, burnt, wrong' },
  { code: 'COMP',           label: 'Comp / returned',   hint: 'Sent back or comped' },
  { code: 'OVERPRODUCTION', label: 'Overproduced',      hint: 'Made too much' },
  { code: 'UNKNOWN',        label: 'Other',             hint: 'Say why in the note' },
]

/** Older codes still on past entries (and on the desktop list), shown in plain words. */
const LEGACY_REASONS: readonly WasteReason[] = [
  { code: 'BURNT',      label: 'Burnt',       hint: '' },
  { code: 'EXPIRED',    label: 'Out of date', hint: '' },
  { code: 'STAFF_MEAL', label: 'Staff meal',  hint: '' },
]

/** Every reason the app accepts, phone picks first. */
export const ALL_REASONS: readonly WasteReason[] = [...PICK_REASONS, ...LEGACY_REASONS]
export const WASTE_REASON_CODES: readonly string[] = ALL_REASONS.map(r => r.code)

export function reasonLabel(code: string | null | undefined): string {
  return ALL_REASONS.find(r => r.code === code)?.label ?? (code ? code.toLowerCase().replace(/_/g, ' ') : 'Other')
}

export function isWasteReason(code: unknown): code is string {
  return typeof code === 'string' && WASTE_REASON_CODES.includes(code)
}
