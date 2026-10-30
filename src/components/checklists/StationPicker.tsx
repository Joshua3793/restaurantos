'use client'
import { useEffect, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import type { StationCard } from '@/lib/checklists/cook-view'
import type { Phase } from '@/lib/checklists/rules'
import { firstName } from './LineRow'

// "Where are you today?" — the bottom sheet a cook uses to pick one station,
// or two when covering. Opens by itself when the cook has not picked yet.

const MAX_PICK = 2

const sameName = (a: string | null | undefined, b: string) =>
  !!a && a.trim().toLowerCase() === b.trim().toLowerCase()

/** "YOUR USUAL · 12 JOBS · NOBODY ON IT YET" / "LEO IS ON IT". */
function metaFor(s: StationCard, usual: boolean, myName: string): string {
  // The crew list holds names; drop one copy of mine when I am on it.
  const others = [...s.crew]
  if (s.picked) {
    const i = others.findIndex(n => n === myName)
    if (i >= 0) others.splice(i, 1)
  }
  const names = others.map(n => firstName(n).toUpperCase()).filter(Boolean)
  const parts: string[] = []
  if (usual) parts.push('YOUR USUAL')
  if (names.length === 1) parts.push(`${names[0]} IS ON IT`)
  else if (names.length === 2) parts.push(`${names[0]} + ${names[1]} ARE ON IT`)
  else if (names.length > 2) parts.push(`${names[0]} + ${names.length - 1} MORE ARE ON IT`)
  else {
    parts.push(`${s.jobCount} ${s.jobCount === 1 ? 'JOB' : 'JOBS'}`)
    parts.push(s.picked ? 'YOU’RE ON IT' : 'NOBODY ON IT YET')
  }
  return parts.join(' · ')
}

export function StationPicker({
  stations,
  phase,
  homeStation,
  myName,
  onClose,
  onPick,
}: {
  stations: StationCard[]
  phase: Phase
  homeStation: string | null
  /** The name the crew list stores for this person (name, else email). */
  myName: string
  onClose: () => void
  /** POSTs the pick; resolves true when it saved. */
  onPick: (stationIds: string[]) => Promise<boolean>
}) {
  const list = stations.filter(s => !s.isShared)
  const [sel, setSel] = useState<string[]>(() => {
    const current = list.filter(s => s.picked).map(s => s.id)
    if (current.length > 0) return current.slice(0, MAX_PICK)
    const usual = list.find(s => sameName(homeStation, s.name))
    return usual ? [usual.id] : []
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (id: string) =>
    setSel(prev => (prev.includes(id) ? prev.filter(x => x !== id) : prev.length >= MAX_PICK ? prev : [...prev, id]))

  const names = list.filter(s => sel.includes(s.id)).map(s => s.name)
  const start = async () => {
    if (busy || sel.length === 0) return
    setBusy(true)
    const ok = await onPick(sel)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="presentation">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Pick your station"
        className="relative w-full max-w-[480px] bg-paper rounded-t-[22px] px-4 pt-2.5 pb-[calc(20px+env(safe-area-inset-bottom))] flex flex-col gap-3.5 max-h-[92vh] overflow-y-auto"
      >
        <div className="self-center w-10 h-1 rounded-full bg-line-2" />
        <div className="flex flex-col gap-1.5">
          <h2 className="m-0 text-[20px] leading-[1.2] font-semibold tracking-[-0.03em]">Where are you today?</h2>
          <p className="m-0 text-[14px] leading-[1.45] text-ink-3">Tap one, or two if you’re covering. You can change it any time.</p>
        </div>

        {list.length === 0 ? (
          <p className="m-0 text-[14px] text-ink-3">No stations are set up for this kitchen yet. Ask a manager.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {list.map(s => {
              const on = sel.includes(s.id)
              const full = !on && sel.length >= MAX_PICK
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  aria-disabled={full}
                  onClick={() => toggle(s.id)}
                  className={`flex items-center gap-3 min-h-[58px] px-3.5 py-2 rounded-xl bg-paper text-left ${on ? 'border-2 border-ink' : 'border border-line'} ${full ? 'opacity-50' : ''}`}
                >
                  <span className="flex-none w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                  <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="text-[15px] font-semibold tracking-[-0.015em] text-ink">{s.name}</span>
                    <span className="font-mono text-[10.5px] text-ink-3">{metaFor(s, sameName(homeStation, s.name), myName)}</span>
                  </span>
                  <span className={`flex-none w-[26px] h-[26px] rounded-[7px] grid place-items-center box-border ${on ? 'bg-green border-[1.5px] border-green text-white' : 'border-[1.5px] border-line-2'}`}>
                    {on && <Check size={16} strokeWidth={3} aria-hidden />}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <button
          type="button"
          disabled={sel.length === 0 || busy}
          onClick={start}
          className="h-[50px] rounded-xl bg-ink text-paper text-[14px] font-medium inline-flex items-center justify-center gap-1.5 disabled:bg-bg-2 disabled:text-ink-3"
        >
          {sel.length === 0
            ? 'Pick a station'
            : <>Start {names.join(' + ')} {phase === 'OPEN' ? 'opening' : 'closing'} <ArrowRight size={16} className="text-gold" aria-hidden /></>}
        </button>
      </section>
    </div>
  )
}
