'use client'
import { useSidebar } from '@/contexts/SidebarContext'
import { SidebarEdgeTrigger } from './SidebarEdgeTrigger'
import { CostChromeGate } from './CostChromeGate'

/**
 * Client wrapper around the page content. Owns the reactive left offset:
 *  - pinned  → push content right by the docked sidebar width (240px)
 *  - else    → full-width content with a small left gutter so the floating
 *              toggle button never overlaps the cost-chrome strip / content.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { pinned } = useSidebar()
  return (
    <>
      <SidebarEdgeTrigger />
      <main
        className={`${pinned ? 'md:ml-[240px]' : 'md:pl-12'} pb-20 md:pb-0 mobile-content-top md:pt-0 min-h-screen bg-[#fafaf9] flex flex-col transition-[margin,padding] duration-200`}
      >
        <CostChromeGate />
        <div className="flex-1 p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
          {children}
        </div>
      </main>
    </>
  )
}
