'use client'
import { createContext, useContext, useEffect, useState, useCallback } from 'react'

const STORAGE_KEY = 'controla.sidebar.pinned'

interface SidebarState {
  pinned: boolean
  peeking: boolean
  hydrated: boolean
  togglePinned: () => void
  setPeeking: (v: boolean) => void
}

const SidebarContext = createContext<SidebarState | null>(null)

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  // Default true (docked) so first paint + first-time users match today's layout.
  const [pinned, setPinned] = useState(true)
  const [peeking, setPeeking] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  // Restore persisted choice after mount (avoids SSR/hydration mismatch).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (stored !== null) setPinned(stored === 'true')
    } catch { /* ignore */ }
    setHydrated(true)
  }, [])

  const togglePinned = useCallback(() => {
    setPinned(prev => {
      const next = !prev
      try { window.localStorage.setItem(STORAGE_KEY, String(next)) } catch { /* ignore */ }
      return next
    })
    setPeeking(false)
  }, [])

  return (
    <SidebarContext.Provider value={{ pinned, peeking, hydrated, togglePinned, setPeeking }}>
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  const ctx = useContext(SidebarContext)
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider')
  return ctx
}
