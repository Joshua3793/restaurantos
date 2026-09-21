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

export type ParsedMode =
  | { mode: 'fill-null' | 'refreeze'; apply: boolean }
  | { error: string }

const KNOWN_FLAGS = new Set(['--refreeze', '--fill-null', '--apply'])

/**
 * The script's mode is no longer inferred from an ambient "no flags = default"
 * rule. The rule the default mode was written for has changed underneath it: it
 * fills NULL rows under the OLD rule, and a blanket `--apply` (no material-change
 * filter, no clone handling) would re-break the pre-2026-06-19 clone rows
 * `--refreeze` exists to fix. So a bare `--apply`, naming no mode, is refused
 * outright rather than silently defaulting to fill-null. `--fill-null` and
 * `--refreeze` are mutually exclusive; an unrecognised flag (a typo like
 * `--aply`) is refused rather than falling through to a mode nobody asked for.
 */
export function parseMode(argv: string[]): ParsedMode {
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a))
  if (unknown.length > 0) {
    return { error: `Unknown flag(s): ${unknown.join(', ')}` }
  }
  const refreeze = argv.includes('--refreeze')
  const fillNull = argv.includes('--fill-null')
  const apply = argv.includes('--apply')

  if (refreeze && fillNull) {
    return { error: '--refreeze and --fill-null are mutually exclusive — pick one mode.' }
  }
  if (apply && !refreeze && !fillNull) {
    return {
      error:
        'A bare --apply names no mode and is refused. The default (fill-null) mode only ever ' +
        'fills NULL receivedQtyBase rows under the OLD rule; the rule has since changed, and ' +
        'applying it blanket-wide (no material-change filter, no clone handling) would re-break ' +
        'the pre-2026-06-19 clone rows --refreeze fixes. Pass --refreeze --apply to recompute ' +
        'every approved line under the CURRENT rule, or --fill-null --apply to run the original ' +
        'NULL-filling mode explicitly.',
    }
  }
  return { mode: refreeze ? 'refreeze' : 'fill-null', apply }
}
