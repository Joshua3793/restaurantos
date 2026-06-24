// src/lib/dates.ts
/** Start of the current week — Monday 00:00 local time. */
export function startOfWeek(d: Date): Date {
  const out = new Date(d)
  const day = out.getDay() || 7 // Sun = 0 → 7
  if (day !== 1) out.setHours(-24 * (day - 1))
  out.setHours(0, 0, 0, 0)
  return out
}

/** Start of the month containing `d` — 1st 00:00 local time. */
export function startOfMonth(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), 1)
  out.setHours(0, 0, 0, 0)
  return out
}

/** Start of the calendar quarter containing `d` — Jan/Apr/Jul/Oct 1st 00:00 local. */
export function startOfQuarter(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3) * 3
  const out = new Date(d.getFullYear(), q, 1)
  out.setHours(0, 0, 0, 0)
  return out
}

/** End of the day containing `d` — 23:59:59.999 local time. Makes a date range inclusive of `to`. */
export function endOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(23, 59, 59, 999)
  return out
}

/** [Monday, Sunday-end] of the week BEFORE the week containing `d`. */
export function lastWeekRange(d: Date): { from: Date; to: Date } {
  const thisMonday = startOfWeek(d)
  const lastMonday = new Date(thisMonday)
  lastMonday.setDate(lastMonday.getDate() - 7)
  const lastSunday = new Date(thisMonday)
  lastSunday.setDate(lastSunday.getDate() - 1)
  return { from: lastMonday, to: endOfDay(lastSunday) }
}
