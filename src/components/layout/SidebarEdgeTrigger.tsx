'use client'
import { PanelLeft } from 'lucide-react'
import { useSidebar } from '@/contexts/SidebarContext'

/**
 * Desktop-only controls for the collapsible sidebar:
 *  - a thin invisible hover strip at the far-left edge that summons a peek
 *  - a floating toggle button (top-left) that pins / unpins the sidebar
 * Both are hidden on mobile (md:block), where the bottom tab bar owns nav.
 */
export function SidebarEdgeTrigger() {
  const { pinned, setPeeking, togglePinned } = useSidebar()

  return (
    <>
      {/* Edge-hover summon zone — only meaningful when unpinned */}
      {!pinned && (
        <div
          aria-hidden
          onMouseEnter={() => setPeeking(true)}
          className="hidden md:block fixed left-0 top-0 w-1.5 h-screen z-40"
        />
      )}

      {/* Floating toggle button */}
      <button
        onClick={togglePinned}
        title={pinned ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-label={pinned ? 'Collapse sidebar' : 'Expand sidebar'}
        className={`hidden md:flex fixed top-3 left-3 z-50 w-8 h-8 items-center justify-center rounded-lg transition-colors ${
          pinned
            ? 'text-zinc-400 hover:text-white hover:bg-white/10'
            : 'text-ink-3 hover:text-ink bg-paper/80 backdrop-blur border border-line shadow-sm hover:bg-paper'
        }`}
      >
        <PanelLeft size={16} />
      </button>
    </>
  )
}
