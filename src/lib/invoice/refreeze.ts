// Pure decision pieces for the `--refreeze` mode of
// scripts/backfill-received-qty-base.ts. Extracted here (rather than left inline
// in the script) purely so they can be unit-tested without Prisma — the script
// itself has a top-level `main()` call and cannot be imported. Pure + client-safe.

const finite = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : NaN
}

/**
 * An RC-clone line carries a SHARE of its parent's newly-computed value — never
 * the rule. Returns `clone/parent`, or `null` unless both totals are finite and
 * strictly positive (a zero or missing total can't honestly be shared, and the
 * caller must then count the clone as an orphan rather than guess).
 */
export function cloneShare(parentTotal: unknown, cloneTotal: unknown): number | null {
  const p = finite(parentTotal)
  const c = finite(cloneTotal)
  if (!(p > 0) || !(c > 0)) return null
  return c / p
}

/**
 * Is `next` a material change from the frozen `prev`? Same tolerance as the
 * original backfill's dry-run diff: bigger than 0.001 base units, or bigger than
 * 0.5% of `prev` — whichever is larger. A line frozen at 0 that recomputes to any
 * positive value is always material (0% would otherwise hide it).
 */
export function isMaterialChange(prev: number, next: number): boolean {
  if (prev === 0) return next > 0
  return Math.abs(next - prev) > Math.max(0.001, Math.abs(prev) * 0.005)
}
