'use client'
import { usePathname } from 'next/navigation'
import { CostChrome } from './CostChrome'
import { isAuthRoute, isSpineRoute } from '@/lib/chrome-routes'

/**
 * Mounts the top bar (CostChrome) on every app route except auth/standalone
 * pages. On spine routes the bar also shows the live cost KPIs; elsewhere it's
 * just the brand + bell shell so the logo stays pinned everywhere.
 */
export function CostChromeGate() {
  const pathname = usePathname()
  if (isAuthRoute(pathname)) return null
  const onSpine = isSpineRoute(pathname)
  // On prep, the KPI strip is read-only and crowds the mobile list — desktop-only there.
  const desktopOnly = pathname === '/prep' || (pathname?.startsWith('/prep/') ?? false)
  return <CostChrome onSpine={onSpine} desktopOnly={desktopOnly} />
}
