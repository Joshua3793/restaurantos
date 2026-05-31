// Shared route gating for the desktop top bar (CostChrome) and the sidebar
// vertical offset. Kept in one place so AppShell, CostChromeGate, and
// Navigation all agree on where the chrome appears.

/** Routes whose top bar shows the live cost KPIs. */
export const SPINE_ROUTES = [
  '/',
  '/today',
  '/pass',
  '/preshift',
  '/prep',
  '/count',
  '/inventory',
  '/recipes',
  '/menu',
  '/invoices',
  '/cost',
  '/variance',
  '/signals',
  '/sales',
  '/wastage',
]

// Auth / standalone routes that render no app chrome — no top bar, and the
// sidebar stays full-height from the very top.
const AUTH_PREFIXES = ['/login', '/auth', '/settings']

function matches(pathname: string, prefixes: string[]): boolean {
  return prefixes.some(p => pathname === p || pathname.startsWith(p + '/'))
}

/** True on auth/standalone routes that should show no top bar. */
export function isAuthRoute(pathname: string | null): boolean {
  if (!pathname) return true
  return matches(pathname, AUTH_PREFIXES)
}

/** True on routes that expose the live cost KPIs in the top bar. */
export function isSpineRoute(pathname: string | null): boolean {
  if (!pathname) return false
  return matches(pathname, SPINE_ROUTES)
}
