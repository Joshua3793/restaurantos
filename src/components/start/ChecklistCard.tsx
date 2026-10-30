'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, ChevronRight, ListChecks } from 'lucide-react'
import type { Phase } from '@/lib/checklists/rules'
import type { CookView } from '@/lib/checklists/cook-view'
import { checklistSummary } from '@/lib/start-page'

// The station checklist on the cook's start page: one line that says where this
// cook's opening (or closing) list stands, and links to /checklist where the
// ticking happens. Three states — no station picked yet, in progress, done.
// No money.

const POLL_MS = 60_000

const getJson = (url: string) =>
  fetch(url, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)

export function ChecklistCard({ rcId, phase }: { rcId: string | null; phase: Phase }) {
  const [view, setView] = useState<CookView | null>(null)

  useEffect(() => {
    setView(null)
    if (!rcId) return
    let cancelled = false
    const load = () => {
      getJson(`/api/checklists?rcId=${rcId}&phase=${phase}`).then((v: CookView | null) => {
        if (!cancelled && v && Array.isArray(v.mine)) setView(v)
      })
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [rcId, phase])

  // Nothing to say for a location view, or before the first answer lands.
  if (!rcId || !view) return null

  const s = checklistSummary(view)
  const word = phase === 'OPEN' ? 'opening' : 'closing'

  if (s.state === 'done') {
    return (
      <Link href="/checklist" className="w-full flex items-center gap-2.5 bg-green-soft rounded-[14px] px-4 min-h-[52px]">
        <Check size={16} className="text-green-text shrink-0" />
        <span className="flex-1 text-[14px] font-semibold text-green-text">
          {phase === 'OPEN' ? 'Opening' : 'Closing'} done · {s.handled} of {s.total}
        </span>
        <ChevronRight size={17} className="text-green-text shrink-0" />
      </Link>
    )
  }

  if (s.state === 'pick') {
    return (
      <Link href="/checklist" className="flex items-center gap-3 bg-paper border border-line rounded-[14px] px-4 min-h-[56px]">
        <span className="w-7 h-7 rounded-lg grid place-items-center bg-bg-2 text-ink-2 shrink-0"><ListChecks size={15} /></span>
        <span className="flex-1 min-w-0 text-[14.5px] font-semibold text-ink">Pick your station to start {word} →</span>
      </Link>
    )
  }

  const urgent = s.blockersLeft > 0 && phase === 'OPEN'
  const left = s.blockersLeft > 0
    ? phase === 'OPEN' ? `${s.blockersLeft} before doors` : `${s.blockersLeft} left before you leave`
    : null
  return (
    <Link
      href="/checklist"
      className={`flex items-center gap-3 bg-paper border rounded-[14px] px-4 min-h-[56px] ${urgent ? 'border-red-soft' : 'border-line'}`}
    >
      <span className={`w-7 h-7 rounded-lg grid place-items-center shrink-0 ${urgent ? 'bg-red-soft text-red-text' : 'bg-bg-2 text-ink-2'}`}>
        <ListChecks size={15} />
      </span>
      <span className="flex-1 min-w-0 text-[14.5px] font-semibold text-ink">
        {s.names} {word} · {s.handled} of {s.total}
        {left && <span className={urgent ? 'text-red-text' : 'text-ink-3 font-medium'}> · {left}</span>}
      </span>
      <ChevronRight size={17} className="text-ink-4 shrink-0" />
    </Link>
  )
}
