'use client'
// One "refresh now" signal for the whole app: a phone pull-down
// (PullToRefresh) or the phone app coming back to the front fires the window
// event 'app:refresh'; pages that load their own data re-run their loader.
import { useEffect, useRef } from 'react'

export const APP_REFRESH_EVENT = 'app:refresh'

export function fireAppRefresh() {
  if (typeof window === 'undefined') return
  try { window.dispatchEvent(new Event(APP_REFRESH_EVENT)) } catch { /* very old browser */ }
}

/** Runs `cb` on every 'app:refresh'. `cb` may change each render. */
export function useAppRefresh(cb: () => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    const on = () => { try { ref.current() } catch { /* a page's loader handles its own errors */ } }
    window.addEventListener(APP_REFRESH_EVENT, on)
    return () => window.removeEventListener(APP_REFRESH_EVENT, on)
  }, [])
}
