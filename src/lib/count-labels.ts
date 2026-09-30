// Count page — the words an item box uses for amounts and variance. Pure, so
// the row, the open card and the phone sheet all say the same thing.

/** "18", "2.5", "0.25" — never "18.00". */
export function fmtCount(n: number): string {
  const v = Math.round(Number(n) * 100) / 100
  return String(Object.is(v, -0) ? 0 : v)
}

export type GapTone = 'short' | 'over' | 'ok'

/**
 * Counted vs expected, in the unit being counted: "22 each short",
 * "3 case over", or "on target" within ±2%. Null when nothing is expected —
 * a percentage against zero ("+0.0%", "−100%") told the cook nothing.
 */
export function countGap(counted: number, expected: number, unit: string): { text: string; tone: GapTone } | null {
  if (!(expected > 0)) return null
  const pct = ((counted - expected) / expected) * 100
  if (Math.abs(pct) < 2) return { text: 'on target', tone: 'ok' }
  const d = counted - expected
  return { text: `${fmtCount(Math.abs(d))} ${unit} ${d < 0 ? 'short' : 'over'}`, tone: d < 0 ? 'short' : 'over' }
}

export const GAP_CLASS: Record<GapTone, string> = {
  short: 'text-red-text',
  over: 'text-gold-2',
  ok: 'text-green-text',
}
