'use client'
import { useEffect, useState } from 'react'

/**
 * Whether a CSS media query matches — `null` until measured on the client, so the
 * first render can still draw both layouts (exactly as the CSS-only split did).
 *
 * Pages with a phone and a desktop renderer use this to mount only the one on
 * screen: the hidden copy of a long list (inventory, a 400-line count) doubled the
 * elements on the page and made every keystroke and drawer slower.
 */
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const sync = () => setMatches(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [query])
  return matches
}
