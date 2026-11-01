'use client'
import { useEffect, useState } from 'react'
import type { Role } from '@prisma/client'
import { useUser } from '@/contexts/UserContext'
import { useRc } from '@/contexts/RevenueCenterContext'
import { SectionTabs } from '@/components/nav/SectionTabs'
import { checklistTabs, type ChecklistTabCounts, type ChecklistTabKey } from '@/lib/section-tabs'

// The Open & close tab row, on every page of the section. A cook sees none.
// The counts (stations behind, phones waiting) load once per page and again
// whenever the phone comes back to the app.

export function ChecklistTabs({ active }: { active: ChecklistTabKey }) {
  const { role } = useUser()
  const { activeRcId, ready } = useRc()
  const [counts, setCounts] = useState<ChecklistTabCounts>({})
  const lead = !!role && checklistTabs(role as Role).length > 0

  useEffect(() => {
    setCounts({})
    if (!lead || !ready || !activeRcId) return
    let live = true
    const load = () => {
      if (document.visibilityState === 'hidden') return
      fetch(`/api/checklists/tab-counts?rcId=${encodeURIComponent(activeRcId)}`, { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (live && d) setCounts({ behind: d.behind ?? 0, phones: d.phones ?? 0 }) })
        .catch(() => {})
    }
    load()
    document.addEventListener('visibilitychange', load)
    return () => { live = false; document.removeEventListener('visibilitychange', load) }
  }, [lead, ready, activeRcId])

  return <SectionTabs tabs={checklistTabs(role as Role | null, counts)} active={active} label="Open & close pages" />
}
