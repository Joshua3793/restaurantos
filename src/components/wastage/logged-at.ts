// When a waste entry was written. WastageLog has no createdAt column; its id is a
// Prisma cuid (v1), whose characters 1–8 are the creation time in base-36 ms.
// Anything that doesn't parse to a sane time falls back to the entry's day marker
// (UTC midnight of the Pacific day — never later than the real time, so for the
// delete window the fallback only ever shortens it).
//
// Pure and client-safe: the delete rule (server) and the card's time (phone) share it.
export function loggedAtOf(log: { id: string; date: Date | string }, now: Date = new Date()): Date {
  if (/^c[0-9a-z]{24,}$/.test(log.id)) {
    const ms = parseInt(log.id.slice(1, 9), 36)
    if (ms > Date.UTC(2020, 0, 1) && ms <= now.getTime() + 60_000) return new Date(ms)
  }
  return new Date(log.date)
}

/** True when the time is a real one (from the id), not the bare day marker. */
export function hasLoggedTime(log: { id: string; date: Date | string }): boolean {
  return loggedAtOf(log).getTime() !== new Date(log.date).getTime()
}
