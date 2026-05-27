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
  '/pass',
  '/prep',
  '/count',
  '/inventory',
  '/inventory/count',
  '/recipes',
  '/menu',
  '/invoices',
  '/reports',
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
  '/settings',
  '/suppliers',
  '/revenue-centers',
  '/storage-areas',
]

export function CostChromeGate() {
  const pathname = usePathname()
  if (!pathname) return null
  if (HIDDEN_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))) return null
  const onSpine = SPINE_ROUTES.some(p => pathname === p || pathname.startsWith(p + '/'))
  if (!onSpine) return null
  return <CostChrome />
}
