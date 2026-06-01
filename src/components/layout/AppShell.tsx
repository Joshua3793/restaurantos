'use client'
import { usePathname } from 'next/navigation'
import { useSidebar } from '@/contexts/SidebarContext'
import { SidebarEdgeTrigger } from './SidebarEdgeTrigger'
import { CostChromeGate } from './CostChromeGate'
import { isAuthRoute } from '@/lib/chrome-routes'

/**
 * Client wrapper around the page content. Owns two reactive offsets:
 *  - left: pinned → push content right by the docked sidebar width (240px);
 *          else → full-width content with a small gutter for the pull tab.
 *  - top: on app routes, clear the fixed full-width top bar (CostChrome),
 *         which spans over the sidebar column so the brand stays pinned.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { pinned } = useSidebar()
  const pathname = usePathname()
  const topBar = !isAuthRoute(pathname)
  return (
    <>
      <SidebarEdgeTrigger />
      <main
        className={`${pinned ? 'md:ml-[240px]' : 'md:pl-12'} ${topBar ? 'md:pt-11' : 'md:pt-0'} pb-20 md:pb-0 mobile-content-top min-h-screen bg-[#fafaf9] flex flex-col transition-[margin,padding] duration-200`}
      >
        <CostChromeGate />
        <div className="flex-1 p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full min-w-0 overflow-x-clip">
          {children}
        </div>
      </main>
    </>
  )
}
