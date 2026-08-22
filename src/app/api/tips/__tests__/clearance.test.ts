import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Pins the security invariant of the tip-payouts feature:
 *
 *   `/api/tips/me` is the ONE staff-reachable route under `/api/tips/*`.
 *   Every other route there must gate itself with `requireSession('MANAGER')`.
 *
 * This is enumerated from the FILESYSTEM at test time — not from a
 * hard-coded list of today's route files. The risk this test exists to
 * catch is someone adding a NEW route.ts under src/app/api/tips/ later with
 * a bare `requireSession()` (or relaxing an existing MANAGER gate); a
 * hard-coded list of "the 13 known files" would silently miss that new
 * file and the test would keep passing while the hole opened. Walking the
 * directory means any new route.ts is automatically part of the universe
 * this test checks.
 */

const TIPS_API_ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..'

// The single deliberate staff-reachable exception. Listing it explicitly
// here (rather than e.g. special-casing "the file named me") means adding a
// SECOND exception requires a conscious edit to this test, not something
// that falls out of a naming coincidence.
const STAFF_REACHABLE_ROUTES = new Set<string>(['me/route.ts'])

function findRouteFiles(dir: string, base = ''): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  let files: string[] = []
  for (const entry of entries) {
    if (entry.name === '__tests__') continue
    const rel = base ? `${base}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files = files.concat(findRouteFiles(full, rel))
    } else if (entry.name === 'route.ts') {
      files.push(rel)
    }
  }
  return files
}

// Strip `//` line comments and `/* */` block comments before scanning for
// `requireSession(...)` call sites. me/route.ts's header doc-comment
// explains the invariant in prose ("every other route ... is
// requireSession('MANAGER')") — without stripping, that sentence would be
// misread as an actual MANAGER-gated call and silently satisfy the assertion
// even if the real code below it had no guard at all.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// Matches only actual call sites: `requireSession(` with an optional single
// quoted-string argument. Type-only uses like `ReturnType<typeof
// requireSession>` and the `import { requireSession }` specifier have no
// `(` immediately after the identifier, so they never match.
function requireSessionCalls(src: string): (string | null)[] {
  const calls: (string | null)[] = []
  const re = /requireSession\s*\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    calls.push(m[1] ?? m[2] ?? null)
  }
  return calls
}

describe('tips API clearance invariant', () => {
  const routeFiles = findRouteFiles(TIPS_API_ROOT)

  it('walks the filesystem and finds route.ts files (sanity check on the walk itself)', () => {
    // Guards against the walk silently finding nothing (wrong path, renamed
    // dir, etc.) and every other assertion below vacuously passing.
    expect(routeFiles.length).toBeGreaterThan(5)
    expect(routeFiles).toContain('me/route.ts')
  })

  for (const relPath of routeFiles) {
    const isStaffReachable = STAFF_REACHABLE_ROUTES.has(relPath)

    it(
      isStaffReachable
        ? `${relPath} is the deliberate staff-reachable exception — requireSession() with no minRole`
        : `${relPath} gates every requireSession() call at MANAGER`,
      () => {
        const src = fs.readFileSync(path.join(TIPS_API_ROOT, relPath), 'utf8')
        const code = stripComments(src)
        const calls = requireSessionCalls(code)

        // Every route must actually call requireSession at least once —
        // an ungated route (no call at all) is exactly as dangerous as a
        // wrongly-gated one and must fail here too.
        expect(calls.length).toBeGreaterThan(0)

        if (isStaffReachable) {
          for (const arg of calls) expect(arg).toBeNull()
        } else {
          for (const arg of calls) expect(arg).toBe('MANAGER')
        }
      },
    )
  }
})
