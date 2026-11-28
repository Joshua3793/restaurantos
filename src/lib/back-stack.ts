'use client'
// The dismiss stack — every open sheet, drawer and panel, newest last.
//
// In the phone app (Capacitor) the Android back button closes the top-most
// open sheet; with none open it goes back a page, or tucks the app away when
// there is no page to go back to. Pull-to-refresh reads the same stack to stay
// out of the way while a sheet is up.
//
// In a plain browser nothing listens to the back button — the stack is only
// bookkeeping, no history tricks.
import { useEffect, useRef } from 'react'
import { isNative } from './capacitor'
import { minimizeApp, onNativeBack } from './native'

interface Entry { id: number; close: () => void }

const stack: Entry[] = []
let nextId = 1

/** True while any sheet/drawer registered with useBackDismiss is open. */
export function hasOpenSheet(): boolean {
  return stack.length > 0
}

/** Closes the top-most open sheet. False when none is open. */
export function dismissTop(): boolean {
  const top = stack[stack.length - 1]
  if (!top) return false
  try { top.close() } catch { /* a broken close must not wedge the stack */ }
  return true
}

/** The native back button: top sheet → previous page → minimise. */
export function handleNativeBack(canGoBack: boolean) {
  if (dismissTop()) return
  if (canGoBack && typeof window !== 'undefined' && window.history.length > 1) window.history.back()
  else void minimizeApp()
}

let installed = false
/** Called once by the app shell. No-op in a browser. Returns an uninstall. */
export function installNativeBack(): () => void {
  if (installed || !isNative()) return () => {}
  installed = true
  const off = onNativeBack(handleNativeBack)
  return () => { installed = false; off() }
}

/**
 * Registers a sheet on the dismiss stack while `open` is true. `onClose` may
 * change every render — the latest one is called. For a sheet that is only
 * mounted while open, pass `true`.
 */
export function useBackDismiss(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const entry: Entry = { id: nextId++, close: () => closeRef.current() }
    stack.push(entry)
    return () => {
      const i = stack.findIndex(e => e.id === entry.id)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [open])
}
