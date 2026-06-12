// src/lib/dates.ts
/** Start of the current week — Monday 00:00 local time. */
export function startOfWeek(d: Date): Date {
  const out = new Date(d)
  const day = out.getDay() || 7 // Sun = 0 → 7
  if (day !== 1) out.setHours(-24 * (day - 1))
  out.setHours(0, 0, 0, 0)
  return out
}
