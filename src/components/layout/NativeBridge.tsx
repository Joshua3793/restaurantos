'use client'
// Phone-app wiring, mounted once in the app shell: the Android back button
// walks the dismiss stack, coming back to the front refreshes the page's
// data, and the status bar text flips to white on the dark sign-in screens.
// Renders nothing; does nothing in a browser.
import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { installNativeBack } from '@/lib/back-stack'
import { onNativeResume, setStatusBarText } from '@/lib/native'
import { fireAppRefresh } from '@/lib/app-refresh'

const DARK_SCREENS = ['/login', '/auth']

export function NativeBridge() {
  const pathname = usePathname() ?? ''
  useEffect(() => {
    const offBack = installNativeBack()
    const offResume = onNativeResume(fireAppRefresh)
    return () => { offBack(); offResume() }
  }, [])
  useEffect(() => {
    const dark = DARK_SCREENS.some(p => pathname === p || pathname.startsWith(p + '/'))
    void setStatusBarText(dark ? 'light-text' : 'dark-text')
  }, [pathname])
  return null
}
