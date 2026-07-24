'use client'
// Prep run-sheet — assignee chip + claim popover.
// Ported from shared.jsx's PTAv (AssigneeChip) and the claim popover markup
// inlined in desktop.jsx's DRow (ClaimPopover). Uses handlers, so this file
// is a Client Component.
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

// Matches the shape returned by GET /api/prep/cooks and PrepItemRich.assignedCook.
export type Cook = {
  id: string
  name: string
  initials: string
  homeStation: string | null
}

// ─── AssigneeChip ────────────────────────────────────────────────────────
// Dark chip with gold dot + initials when claimed; dashed "+ CLAIM" when open.
export function AssigneeChip({
  cook,
  size = 'md',
  onClick,
}: {
  cook: Cook | null
  size?: 'sm' | 'md'
  onClick?: () => void
}) {
  const pad = size === 'sm' ? 'px-2 py-[3px]' : 'px-[10px] py-[5px]'

  if (cook) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-[5px] bg-ink text-paper border border-ink rounded-full ${pad} font-mono text-[10px] font-semibold tracking-[0.02em] whitespace-nowrap ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <span className="w-[6px] h-[6px] rounded-full bg-gold" />
        {cook.initials}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 bg-paper text-ink-3 border border-dashed border-line-2 rounded-full ${pad} font-mono text-[10px] font-semibold tracking-[0.02em] whitespace-nowrap cursor-pointer`}
    >
      + CLAIM
    </button>
  )
}

// ─── ClaimPopover ────────────────────────────────────────────────────────
// Click-away backdrop + a right-aligned menu of cooks (initials, first name,
// home station) with an UNASSIGN row. Rendered in a portal on document.body and
// positioned `fixed` off the trigger's rect, so it is never clipped by an
// ancestor's overflow (e.g. the in-progress rail's horizontal scroller) or
// contained by the page's `container-type` context.
export function ClaimPopover({
  cooks,
  currentId,
  onPick,
  onClose,
  anchorRef,
}: {
  cooks: Cook[]
  currentId: string | null
  onPick: (cookId: string | null) => void
  onClose: () => void
  /** The trigger's wrapper element — the menu positions itself below/right of it. */
  anchorRef: RefObject<HTMLElement | null>
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    const a = anchor.getBoundingClientRect()
    const h = menu.offsetHeight
    const WIDTH = 172
    let left = a.right - WIDTH
    if (left < 8) left = 8
    if (left + WIDTH > window.innerWidth - 8) left = window.innerWidth - 8 - WIDTH
    // Below the trigger by default; flip above if it would run off the viewport bottom.
    let top = a.bottom + 4
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 4)
    setPos({ top, left })
  }, [anchorRef, cooks.length])

  if (typeof document === 'undefined') return null

  return createPortal(
    <>
      <div onClick={onClose} className="fixed inset-0 z-[60]" />
      <div
        ref={menuRef}
        style={{
          position: 'fixed',
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          visibility: pos ? 'visible' : 'hidden',
        }}
        className="z-[61] bg-paper border border-line-2 rounded-[11px] shadow-[0_12px_32px_rgba(0,0,0,0.14)] p-1 w-[172px]"
      >
        {cooks.length === 0 && (
          // No crew yet → the picker would otherwise show a lone UNASSIGN row and the
          // pill looks broken ("nothing happens"). Point the user at where to add cooks.
          <a
            href="/setup/kitchen-crew"
            className="block rounded-[8px] px-[10px] py-2 text-[12px] text-ink-3 leading-snug hover:bg-bg-2"
          >
            No kitchen crew yet — <span className="text-gold-2 font-medium">add cooks in Setup&nbsp;→&nbsp;Kitchen&nbsp;crew</span>
          </a>
        )}
        {cooks.map(c => (
          <button
            key={c.id}
            type="button"
            onClick={() => onPick(c.id)}
            className={`flex items-center gap-2 w-full text-left rounded-[8px] px-[10px] py-2 cursor-pointer ${currentId === c.id ? 'bg-bg-2' : 'bg-transparent'}`}
          >
            <span className="font-mono text-[9px] font-bold text-gold-2">{c.initials}</span>
            <span className="text-[12.5px] font-medium text-ink">{c.name.split(' ')[0]}</span>
            <span className="font-mono text-[9px] text-ink-4 ml-auto">{c.homeStation ?? ''}</span>
          </button>
        ))}
        {cooks.length > 0 && (
          <button
            type="button"
            onClick={() => onPick(null)}
            className="block w-full text-left bg-transparent border-t border-line px-[10px] py-2 cursor-pointer font-mono text-[10px] text-ink-3"
          >
            UNASSIGN
          </button>
        )}
      </div>
    </>,
    document.body,
  )
}
