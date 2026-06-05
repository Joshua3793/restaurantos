'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Global keyboard shortcuts:
 *   ⌘1 → /pass        (Today)
 *   ⌘2 → /invoices    (Inbox)
 *   ⌘3 → /inventory   (Library)
 *   ⌘4 → /reports     (Insights)
 *   ⌘5 → /setup       (Setup)
 *
 * ⌘K is owned by GlobalSearch.
 */
const ROUTES: Record<string, string> = {
  '1': '/pass',
  '2': '/invoices',
  '3': '/inventory',
  '4': '/reports',
  '5': '/setup',
}

export function KeyboardShortcuts() {
  const router = useRouter()
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      // Avoid stealing browser-native chord/save/etc
      if (e.shiftKey || e.altKey) return
      // Don't fire if user is typing in an input
      const t = e.target as HTMLElement | null
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (t?.isContentEditable) return
      const dest = ROUTES[e.key]
      if (dest) {
        e.preventDefault()
        router.push(dest)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [router])
  return null
}
