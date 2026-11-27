'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/contexts/UserContext'
import { StartMobile } from '@/components/start/StartMobile'
import { CookStart } from '@/components/start/CookStart'
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
      <div>
        <div className="pt-10 font-mono text-[11px] text-ink-3">Loading…</div>
      </div>
    )
  }

  const isManager = role != null && atLeast(role, 'MANAGER')
  // LEAD+ get the Pass; STAFF keep the cook's start page.
  const isLead = role != null && atLeast(role, 'LEAD')
  return (
    // Replaces MScreen, which is md:hidden and shared with mobile-only screens.
    // The side gutter and the tab-bar clearance come from AppShell (p-4 + pb-20
    // on phones), the same as every other page — no padding of its own here,
    // or Today sat 32px in from each edge with a tall empty strip at the end.
    //
    // Managers keep md:hidden: the effect above bounces them to /pass, but it
    // only runs after first paint, and / -> /today -> /pass is their normal
    // desktop landing path — without this they would see the mobile Today
    // screen flash on every login.
    //
    // A LEAD has no desktop Pass: they get the phone Pass in a narrow column.
    <div
      className={`bg-bg text-ink ${
        isManager ? 'md:hidden' : isLead ? 'md:max-w-[640px] md:mx-auto md:w-full' : ''
      }`}
    >
      {isLead ? <StartMobile /> : <CookStart />}
    </div>
  )
}
