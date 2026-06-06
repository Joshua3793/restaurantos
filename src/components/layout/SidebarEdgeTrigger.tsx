'use client'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useSidebar } from '@/contexts/SidebarContext'

/**
 * Desktop-only controls for the collapsible sidebar:
 *  - a thin invisible hover strip at the far-left edge that summons a peek
 *  - a vertically-centered pull / push tab that rides the right edge of the
 *    visible sidebar (x=240 when shown, flush-left x=0 when collapsed), so the
 *    chevron reads as pulling the menu out or pushing it closed.
 * Both are hidden on mobile (md:*), where the bottom tab bar owns nav.
 *
 * The tab shares the peek-keep-alive with the <aside> (onMouseEnter/Leave),
 * so it and the sidebar behave as one hover region — moving between them
 * doesn't flicker the peek closed.
 */
export function SidebarEdgeTrigger() {
  const { pinned, peeking, setPeeking, togglePinned } = useSidebar()
  const visible = pinned || peeking

  return (
    <>
      {/* Edge-hover summon zone — only meaningful when collapsed */}
      {!pinned && (
        <div
          aria-hidden
          onMouseEnter={() => setPeeking(true)}
          className="hidden md:block fixed left-0 top-0 w-1.5 h-screen z-40"
        />
      )}

      {/* Pull / push tab — vertically centered on the sidebar's right edge */}
      <button
        onClick={togglePinned}
        onMouseEnter={() => { if (!pinned) setPeeking(true) }}
        onMouseLeave={() => { if (!pinned) setPeeking(false) }}
        title={pinned ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-label={pinned ? 'Collapse sidebar' : 'Expand sidebar'}
        className={`hidden md:flex fixed top-1/2 -translate-y-1/2 z-50 w-5 h-12 items-center justify-center transition-all duration-200 ${
          visible
            ? 'left-[240px] -translate-x-1/2 rounded-md bg-[#18181b] border border-ink-2 text-ink-4 hover:text-white hover:bg-ink-2'
            : 'left-0 rounded-r-md border border-l-0 border-line bg-paper text-ink-3 shadow-sm hover:text-ink hover:bg-bg-2'
        }`}
      >
        {pinned ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
      </button>
    </>
  )
}
