'use client'
import { usePathname } from 'next/navigation'
import { CostChrome } from './CostChrome'

/**
 * Mount CostChrome only on routes that touch the spine
 * (recipes / menu / invoices / count / prep / pass / insights).
 * Auth + setup routes don't get the strip.
 */
const SPINE_ROUTES = [
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

const HIDDEN_PREFIXES = [
  '/login',
  '/auth',
  '/setup',
  '/settings', // legacy; middleware redirects but cover it just in case
]

export function CostChromeGate() {
  const pathname = usePathname()
  if (!pathname) return null
  if (HIDDEN_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))) return null
  const onSpine = SPINE_ROUTES.some(p => pathname === p || pathname.startsWith(p + '/'))
  if (!onSpine) return null
  // On prep, the strip is read-only KPI that crowds the mobile list — desktop-only there.
  const desktopOnly = pathname === '/prep' || pathname.startsWith('/prep/')
  return <CostChrome desktopOnly={desktopOnly} />
}
