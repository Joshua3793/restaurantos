'use client'
import { useState } from 'react'
import Link from 'next/link'
import { Check, ChevronRight, Thermometer } from 'lucide-react'
import { openProgress, bySection, type OpenCheckRow } from '@/lib/open-checklist'
import type { NeedItem } from '@/lib/start-page'
import { personName } from './parts'

// The opening checklist on the cook's start page: temps first (they live in the
// Temps log, so this is a link), then the kitchen's own before-doors list, which
// cooks tick right here. Resets every business day. No money.
//
// While anything is open the card shows every item; once all are done it folds
// to one green line so My jobs takes the screen.
export function OpeningCard({
  rows,
  temp,
  beforeDoors,
  onToggle,
}: {
  rows: OpenCheckRow[]
  /** Today's temps prompt (unlogged or out of range), or null when temps are fine. */
  temp: NeedItem | null
  /** True while the next service has not started — "before doors" items go red. */
  beforeDoors: boolean
  onToggle: (row: OpenCheckRow, done: boolean) => Promise<void>
}) {
  const p = openProgress(rows)
  const allDone = p.done === p.total && !temp
  const [open, setOpen] = useState(false)

  if (rows.length === 0 && !temp) return null

  if (allDone && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2.5 bg-green-soft rounded-[14px] px-4 min-h-[52px] text-left"
      >
        <Check size={16} className="text-green-text shrink-0" />
        <span className="flex-1 text-[14px] font-semibold text-green-text">Opening done · {p.total} of {p.total}</span>
        <span className="text-[12.5px] text-green-text">Show</span>
      </button>
    )
  }

  return (
    <section aria-label="Opening checklist" className="bg-paper border border-line rounded-[14px] overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
        <h2 className="text-[15px] font-semibold">Opening</h2>
        <span className="font-mono text-[10.5px] text-ink-3">
          {p.done} of {p.total} done{beforeDoors && p.blockersLeft > 0 && <span className="text-red-text"> · {p.blockersLeft} before doors</span>}
        </span>
      </header>

      {temp && (
        <Link href="/temps" className="flex items-center gap-3 px-4 py-3 border-b border-bg-2 min-h-[56px]">
          <span className="w-7 h-7 rounded-lg grid place-items-center bg-red-soft text-red-text shrink-0"><Thermometer size={15} /></span>
          <span className="flex-1 min-w-0">
            <span className="block text-[14.5px] font-semibold">{temp.id === 'temp-missing' ? 'Log temps' : temp.title}</span>
            <span className="block text-[12.5px] text-ink-3 mt-0.5">{temp.id === 'temp-missing' ? `${temp.detail} — not done today` : temp.detail}</span>
          </span>
          <ChevronRight size={17} className="text-ink-4 shrink-0" />
        </Link>
      )}

      {bySection(rows).map(g => (
        <div key={g.section}>
          <div className="px-4 pt-3 pb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">{g.section}</div>
          {g.rows.map(r => <TickRow key={r.id} r={r} beforeDoors={beforeDoors} onToggle={onToggle} />)}
        </div>
      ))}

      {allDone && (
        <button type="button" onClick={() => setOpen(false)} className="w-full text-[12.5px] text-ink-3 py-2.5 border-t border-bg-2">Fold away</button>
      )}
    </section>
  )
}

function TickRow({ r, beforeDoors, onToggle }: {
  r: OpenCheckRow
  beforeDoors: boolean
  onToggle: (row: OpenCheckRow, done: boolean) => Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const urgent = r.isBlocker && !r.done && beforeDoors
  const toggle = async () => {
    setSaving(true)
    try { await onToggle(r, !r.done) } finally { setSaving(false) }
  }
  const who = r.done ? personName(r.doneByName) : null
  const at = r.done && r.doneAt
    ? new Date(r.doneAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
    : null
  return (
    <button
      type="button"
      aria-pressed={r.done}
      onClick={toggle}
      disabled={saving}
      className="w-full flex items-center gap-3 px-4 py-2.5 min-h-[52px] text-left hover:bg-bg-2/50 disabled:opacity-60"
    >
      <span className={`w-6 h-6 rounded-md grid place-items-center shrink-0 border ${
        r.done ? 'bg-green border-green text-paper' : urgent ? 'border-red bg-paper' : 'border-line-2 bg-paper'
      }`}>
        {r.done && <Check size={15} strokeWidth={3} />}
      </span>
      <span className="flex-1 min-w-0">
        <span className={`block text-[14.5px] ${r.done ? 'text-ink-3 line-through' : urgent ? 'font-semibold text-red-text' : 'font-medium text-ink'}`}>{r.title}</span>
        {r.done
          ? <span className="block text-[12px] text-ink-4 mt-0.5">{[who, at].filter(Boolean).join(' · ')}</span>
          : r.meta && <span className="block text-[12px] text-ink-3 mt-0.5">{r.meta}</span>}
      </span>
      {urgent && <span className="text-[11px] font-semibold text-red-text whitespace-nowrap">Before doors</span>}
    </button>
  )
}
