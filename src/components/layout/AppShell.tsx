'use client'
import { usePathname } from 'next/navigation'
import { CostChromeGate } from './CostChromeGate'
import { isAuthRoute } from '@/lib/chrome-routes'

/**
 * Client wrapper around the page content. Owns one offset:
 *  - left: push content right by the fixed docked sidebar width (240px) on desktop.
 *  - top: on app routes, clear the fixed full-width top bar (CostChrome),
 *         which spans over the sidebar column so the brand stays pinned.
 *
 * Auth/standalone routes (/login, /auth/*) render no chrome at all, so they get
 * no offsets and no gutter — the page owns the full viewport.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const chrome = !isAuthRoute(pathname)
  return (
    <>
      <main
        className={`${chrome ? 'md:ml-[240px] md:pt-11 pb-20 md:pb-0 mobile-content-top' : ''} min-h-screen bg-bg flex flex-col`}
      >
        <CostChromeGate />
        <div
          className={`flex-1 w-full min-w-0 overflow-x-clip ${
            chrome ? 'p-4 md:p-6 md:px-8 max-w-7xl mx-auto' : ''
          }`}
        >
          {children}
        </div>
      </main>
    </>
  )
}
