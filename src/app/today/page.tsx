'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/contexts/UserContext'
import { MScreen } from '@/components/mobile/kit'
import { TodayManager } from '@/components/mobile/today/TodayManager'
import { TodayChef } from '@/components/mobile/today/TodayChef'

export default function TodayPage() {
  const router = useRouter()
  const { role, loading } = useUser()

  // Desktop has no mobile home — bounce to the role landing (preserves the
  // previous root behaviour: MANAGER/ADMIN → /pass, STAFF → /count).
  useEffect(() => {
    if (loading) return
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      router.replace(role === 'STAFF' ? '/count' : '/pass')
    }
  }, [role, loading, router])

  if (loading) {
    return <MScreen><div className="pt-10 font-mono text-[11px] text-ink-3">Loading…</div></MScreen>
  }

  const isManager = role === 'MANAGER' || role === 'ADMIN'
  return <MScreen>{isManager ? <TodayManager /> : <TodayChef />}</MScreen>
}
