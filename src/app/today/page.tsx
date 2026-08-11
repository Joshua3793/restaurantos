'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/contexts/UserContext'
import { TodayManager } from '@/components/mobile/today/TodayManager'
import { TodayChef } from '@/components/mobile/today/TodayChef'
import { atLeast } from '@/lib/roles'

export default function TodayPage() {
  const router = useRouter()
  const { role, loading } = useUser()

  // Desktop: MANAGER+ still land on the Pass, their real dashboard. Everyone
  // below now RENDERS Today here rather than being bounced to /count — the
  // bounce was half of why a Staff user could never navigate anywhere.
  useEffect(() => {
    if (loading) return
    if (typeof window === 'undefined' || window.innerWidth < 768) return
    if (role != null && atLeast(role, 'MANAGER')) router.replace('/pass')
  }, [role, loading, router])

  if (loading) {
    return (
      <div className="px-4 pb-28 md:px-0 md:pb-0">
        <div className="pt-10 font-mono text-[11px] text-ink-3">Loading…</div>
      </div>
    )
  }

  const isManager = role != null && atLeast(role, 'MANAGER')
  return (
    // Replaces MScreen, which is md:hidden and shared with mobile-only screens.
    // On desktop the padding comes from AppShell, so it is cleared at md+.
    //
    // Managers keep md:hidden: the effect above bounces them to /pass, but it
    // only runs after first paint, and / -> /today -> /pass is their normal
    // desktop landing path — without this they would see the mobile Today
    // screen flash on every login.
    <div
      className={`min-h-screen bg-bg text-ink px-4 pb-28 md:min-h-0 md:px-0 md:pb-0 ${
        isManager ? 'md:hidden' : ''
      }`}
    >
      {isManager ? <TodayManager /> : <TodayChef />}
    </div>
  )
}
