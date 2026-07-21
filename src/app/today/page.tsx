'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/contexts/UserContext'
import { MScreen } from '@/components/mobile/kit'
import { TodayManager } from '@/components/mobile/today/TodayManager'
import { TodayChef } from '@/components/mobile/today/TodayChef'
import { atLeast } from '@/lib/roles'

export default function TodayPage() {
  const router = useRouter()
  const { role, loading } = useUser()

  // Desktop has no mobile home — bounce to the role landing (preserves the
  // previous root behaviour: MANAGER+ → /pass, everyone below (incl. LEAD) →
  // /count). /pass is MANAGER-gated in middleware, so sending a Lead there
  // would bounce them right back through / → /today → /pass in a loop.
  useEffect(() => {
    if (loading) return
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      router.replace(role != null && atLeast(role, 'MANAGER') ? '/pass' : '/count')
    }
  }, [role, loading, router])

  if (loading) {
    return <MScreen><div className="pt-10 font-mono text-[11px] text-ink-3">Loading…</div></MScreen>
  }

  const isManager = role != null && atLeast(role, 'MANAGER')
  return <MScreen>{isManager ? <TodayManager /> : <TodayChef />}</MScreen>
}
