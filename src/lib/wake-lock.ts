'use client'
// Keeps the screen on while `active` — the prep To Do while a job is on the go,
// so a cook's phone does not lock mid-recipe. Browser: the Screen Wake Lock
// API (dropped by the browser whenever the tab is hidden, so it is re-taken on
// return). Phone app: KeepAwake. Unsupported anywhere → silently nothing.
import { useEffect } from 'react'
import { isNative } from './capacitor'
import { nativeKeepAwake } from './native'

interface Sentinel { released: boolean; release(): Promise<void> }
type WakeNav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }

export function useKeepAwake(active: boolean) {
  useEffect(() => {
    if (!active || typeof window === 'undefined') return
    let alive = true
    let sentinel: Sentinel | null = null
    const native = isNative()

    const acquire = async () => {
      if (!alive || document.visibilityState !== 'visible') return
      if (native) { await nativeKeepAwake(true); return }
      if (sentinel && !sentinel.released) return
      try {
        const s = await (navigator as WakeNav).wakeLock?.request('screen')
        if (!s) return
        if (!alive) { void s.release().catch(() => {}); return }
        sentinel = s
      } catch { /* denied, low battery, or unsupported */ }
    }
    const onVis = () => { if (document.visibilityState === 'visible') void acquire() }

    void acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVis)
      if (native) void nativeKeepAwake(false)
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {})
      sentinel = null
    }
  }, [active])
}
