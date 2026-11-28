'use client'
// Pull down to refresh, phones only (below 768px). Starts only when the page
// is at the very top, no sheet is open, and the finger did not land inside a
// scrolled list or a text box. It never blocks scrolling (passive listeners);
// it only draws a small spinner and, past the threshold, fires 'app:refresh'
// (pages re-run their own loaders) plus router.refresh().
import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { hasOpenSheet } from '@/lib/back-stack'
import { fireAppRefresh } from '@/lib/app-refresh'
import { useDrawer } from '@/contexts/DrawerContext'

const THRESHOLD = 64    // px of (damped) pull that triggers a refresh
const MAX_PULL = 96
const MIN_SPIN_MS = 700

function blockedStart(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.closest('input, textarea, select, [contenteditable="true"], [data-no-pull], [role="dialog"], [aria-modal="true"]')) return true
    if (el instanceof HTMLElement) {
      const cs = getComputedStyle(el)
      // Sheets and overlays sit in a fixed layer — a pull there is not a page pull.
      if (cs.position === 'fixed') return true
      const oy = cs.overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight && el.scrollTop > 0) return true
    }
    el = el.parentElement
  }
  return false
}

function bodyLocked(): boolean {
  // Sheets that are not on the dismiss stack still lock the page scroll.
  return document.body.style.overflow === 'hidden' || document.documentElement.style.overflow === 'hidden'
}

export function PullToRefresh() {
  const router = useRouter()
  const wrap = useRef<HTMLDivElement>(null)
  const spinner = useRef<HTMLDivElement>(null)
  // Desktop-style drawers announce themselves here rather than on the dismiss stack.
  const { isAnyDrawerOpen } = useDrawer()
  const drawerOpen = useRef(isAnyDrawerOpen)
  drawerOpen.current = isAnyDrawerOpen

  useEffect(() => {
    let startY = 0, startX = 0, pull = 0
    let tracking = false, busy = false

    const paint = (px: number, spinning: boolean) => {
      const w = wrap.current, s = spinner.current
      if (!w || !s) return
      w.style.opacity = px > 4 || spinning ? '1' : '0'
      w.style.transform = `translate(-50%, ${Math.min(px, MAX_PULL) - 44}px)`
      s.style.transform = spinning ? '' : `rotate(${px * 4}deg)`
      s.classList.toggle('animate-spin', spinning)
      s.style.borderTopColor = px >= THRESHOLD || spinning ? 'currentColor' : 'transparent'
    }
    const reset = () => {
      const w = wrap.current
      if (w) w.style.transition = 'transform 180ms ease, opacity 180ms ease'
      paint(0, false)
    }

    const onStart = (e: TouchEvent) => {
      tracking = false
      if (busy || e.touches.length !== 1 || window.innerWidth >= 768) return
      if (window.scrollY > 0 || document.scrollingElement?.scrollTop) return
      if (hasOpenSheet() || drawerOpen.current || bodyLocked() || blockedStart(e.target)) return
      startY = e.touches[0].clientY
      startX = e.touches[0].clientX
      pull = 0
      tracking = true
      if (wrap.current) wrap.current.style.transition = 'none'
    }
    const onMove = (e: TouchEvent) => {
      if (!tracking) return
      const dy = e.touches[0].clientY - startY
      const dx = Math.abs(e.touches[0].clientX - startX)
      // Scrolling up, sideways swipes, or the page moved under the finger → not a pull.
      if (dy <= 0 || (pull === 0 && dx > dy) || window.scrollY > 0) { tracking = false; reset(); return }
      pull = Math.min(MAX_PULL, dy * 0.5)
      paint(pull, false)
    }
    const onEnd = () => {
      if (!tracking) return
      tracking = false
      if (pull < THRESHOLD) { reset(); return }
      busy = true
      if (wrap.current) wrap.current.style.transition = 'transform 180ms ease'
      paint(THRESHOLD, true)
      fireAppRefresh()
      router.refresh()
      setTimeout(() => { busy = false; reset() }, MIN_SPIN_MS)
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [router])

  return (
    <div
      ref={wrap}
      aria-hidden
      className="md:hidden fixed left-1/2 z-[60] pointer-events-none"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 8px)', opacity: 0, transform: 'translate(-50%, -44px)' }}
    >
      <div className="w-9 h-9 rounded-full bg-paper border border-line shadow-sm flex items-center justify-center text-ink-2">
        <div ref={spinner} className="w-4 h-4 rounded-full border-2 border-line" style={{ borderTopColor: 'transparent' }} />
      </div>
    </div>
  )
}
