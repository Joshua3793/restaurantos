'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Smartphone } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'

// People → "Phone sign-ins · 2 waiting". Phones a cook signs in on with a PIN
// are OK'd there (it moved out of the Checklist tabs).
export function PhoneSignInsLink() {
  const { activeRcId, ready } = useRc()
  const [waiting, setWaiting] = useState<number | null>(null)
  useEffect(() => {
    if (!ready || !activeRcId) return
    let live = true
    fetch(`/api/checklists/tab-counts?rcId=${encodeURIComponent(activeRcId)}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (live && d && typeof d.phones === 'number') setWaiting(d.phones) })
      .catch(() => {})
    return () => { live = false }
  }, [ready, activeRcId])
  return (
    <Link
      href="/setup/sign-ins"
      className="flex items-center gap-2 border border-line-2 bg-paper px-3 py-2.5 rounded-[10px] text-[13px] font-medium text-ink-2 hover:text-ink"
    >
      <Smartphone size={14} aria-hidden /> Phone sign-ins
      {waiting ? (
        <span className="font-mono text-[10.5px] px-1.5 py-px rounded-full bg-red-soft text-red-text">{waiting} waiting</span>
      ) : null}
    </Link>
  )
}
