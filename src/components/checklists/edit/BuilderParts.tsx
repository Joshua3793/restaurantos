'use client'
import { useMemo, useState } from 'react'
import { chipName, phaseCount, type EditStation, type EditTempUnit } from '@/lib/checklists/edit-format'
import { dueText, type Phase } from '@/lib/checklists/rules'
import { andList, phaseWord, previewList, readyBy, weekdayIndex, type TidyUp } from '@/lib/checklists/builder'
import { DAY_NAMES } from '@/lib/checklists/edit-format'

// The computer-width parts of the list builder: the station rail on the left,
// the "Preview as a cook" card, and the tidy-up bar across the top.

/** Left rail: every list with its opening · closing job counts. */
export function StationRail({ stations, selectedId, onSelect, onEdit, onAdd }: {
  stations: EditStation[]
  selectedId: string | null
  onSelect: (id: string) => void
  onEdit: (s: EditStation) => void
  onAdd: () => void
}) {
  return (
    <nav aria-label="Lists" className="bg-paper border border-line rounded-[14px] p-2 flex flex-col gap-0.5">
      <span className="font-mono text-[10px] font-medium tracking-[0.08em] text-ink-3 px-3 pt-1.5 pb-1">LISTS</span>
      {stations.map(s => {
        const on = s.id === selectedId
        return (
          <div key={s.id} className={`flex items-center rounded-[9px] ${on ? 'bg-ink text-paper' : 'hover:bg-bg-2'}`}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(s.id)}
              className="flex-1 min-w-0 flex items-center gap-2 min-h-[40px] pl-3 pr-1 text-left text-[13.5px]"
            >
              <span className="w-2 h-2 rounded-full flex-none" style={{ background: s.color }} aria-hidden />
              <span className={`flex-1 min-w-0 truncate ${on ? 'font-semibold' : ''}`}>{chipName(s)}</span>
              <span className={`font-mono text-[10.5px] ${on ? 'text-ink-4' : 'text-ink-4'}`} title="opening · closing jobs">
                {phaseCount(s, 'OPEN')}·{phaseCount(s, 'CLOSE')}
              </span>
            </button>
            {on && (
              <button type="button" onClick={() => onEdit(s)} className="flex-none min-h-[40px] px-2 font-mono text-[10.5px] text-ink-4 hover:text-paper">
                Edit
              </button>
            )}
          </div>
        )
      })}
      <button type="button" onClick={onAdd} className="min-h-[40px] px-3 text-left font-mono text-[11px] font-medium text-gold-2">
        + New list
      </button>
      <span className="px-3 pb-1 font-mono text-[10px] text-ink-4">numbers = opening · closing jobs</span>
    </nav>
  )
}

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** What a cook would see on this list, on a weekday you pick. */
export function PreviewCard({ station, phase, tempUnits, kitchenJobs }: {
  station: EditStation
  phase: Phase
  tempUnits: EditTempUnit[]
  /** The whole-kitchen list, whose jobs every cook also sees; null when this IS it. */
  kitchenJobs: EditStation | null
}) {
  const [day, setDay] = useState(() => Math.max(0, weekdayIndex(new Date())))
  const range = (id: string | null) => {
    const u = id ? tempUnits.find(t => t.id === id) : null
    return u ? { safeMin: u.safeMin, safeMax: u.safeMax } : null
  }
  const { lines, hidden } = useMemo(() => previewList(station, phase, day, range), [station, phase, day, tempUnits]) // eslint-disable-line react-hooks/exhaustive-deps
  const kitchen = useMemo(() => (kitchenJobs ? previewList(kitchenJobs, phase, day, range).lines.length : 0), [kitchenJobs, phase, day, tempUnits]) // eslint-disable-line react-hooks/exhaustive-deps
  const by = readyBy(station, phase)
  const SHOW = 8

  return (
    <section aria-label="Preview as a cook" className="bg-paper border border-line rounded-[14px] p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-[14px] font-semibold">Preview as a cook</h2>
        <label className="flex items-center gap-1">
          <span className="sr-only">Day</span>
          <select
            value={day}
            onChange={e => setDay(Number(e.target.value))}
            className="h-9 border border-line-2 rounded-[8px] px-2 font-mono text-[11px] text-ink-2 bg-paper"
          >
            {DAY_SHORT.map((d, i) => <option key={d} value={i}>{DAY_NAMES[i]}</option>)}
          </select>
        </label>
      </div>
      <div className="border border-line rounded-[12px] bg-bg p-3 flex flex-col gap-2">
        <span className="font-mono text-[10px] text-ink-3 uppercase">
          {chipName(station)} {phaseWord(phase)} · 0/{lines.length}{by ? ` · by ${dueText(by)}` : ''}
        </span>
        {lines.length === 0 && <span className="text-[12.5px] text-ink-3">Nothing on this list on {DAY_NAMES[day]}.</span>}
        {lines.slice(0, SHOW).map(l => (
          <div key={l.itemId} className="flex items-center gap-2 text-[12.5px] min-w-0">
            <span className="flex-none w-4 h-4 rounded-[5px] border-[1.5px] border-line-2" aria-hidden />
            <span className="flex-1 min-w-0 truncate">{l.title}</span>
            {l.isBlocker && <span className="flex-none font-mono text-[9px] px-1.5 py-px rounded-full bg-red-soft text-red-text">MUST</span>}
            {l.dueBy && <span className="flex-none font-mono text-[9px] px-1.5 py-px rounded-full bg-bg-2 text-ink-3">BY {dueText(l.dueBy)}</span>}
            {l.answer !== 'TICK' && <span className="flex-none font-mono text-[10px] px-1.5 py-px rounded-[6px] border border-line-2 text-ink-3">— {l.unit || ''}</span>}
          </div>
        ))}
        {(lines.length > SHOW || hidden > 0 || kitchen > 0) && (
          <span className="font-mono text-[10px] text-ink-3 leading-[1.5]">
            {[
              lines.length > SHOW ? `+${lines.length - SHOW} more` : '',
              hidden > 0 ? `${hidden} ${hidden === 1 ? 'job' : 'jobs'} not on ${DAY_SHORT[day]}` : '',
              kitchen > 0 ? `+ ${kitchen} whole-kitchen ${kitchen === 1 ? 'job' : 'jobs'}` : '',
            ].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
    </section>
  )
}

/** The words of one suggestion. */
export function tidyText(t: TidyUp): { head: string; body: string; action: string } {
  switch (t.kind) {
    case 'share':
      return {
        head: `“${t.title}” is on ${t.stations.length} ${phaseWord(t.phase).toLowerCase()} lists.`,
        body: `${andList(t.stations)}. If one person does it for everyone, share it: ticked once, done on every list. Settings from ${t.stations[0]}.`,
        action: 'Share it',
      }
    case 'merge':
      return {
        head: `${t.station} ${phaseWord(t.phase).toLowerCase()} has “${t.name}” twice.`,
        body: 'Fold the second into the first. The jobs keep their order.',
        action: 'Merge',
      }
    case 'must':
      return {
        head: `${t.station} ${phaseWord(t.phase).toLowerCase()}: ${t.must} of ${t.total} jobs are must-do.`,
        body: `Keep must-do for what really blocks ${t.phase === 'OPEN' ? 'doors' : 'leaving'}: gas, temps, sanitiser. Then a must-do means something.`,
        action: 'Open list',
      }
  }
}

/** Tidy-up suggestions across the top: three at a time, each with its one action and "Not this". */
export function TidyUpBar({ items, onAct, onDismiss }: {
  items: TidyUp[]
  onAct: (t: TidyUp) => Promise<void>
  onDismiss: (t: TidyUp) => void
}) {
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  if (items.length === 0) return null
  const shown = all ? items : items.slice(0, 3)
  return (
    <section aria-label="Tidy-up suggestions" className="bg-[#fffbeb] border border-[#fde68a] rounded-[14px] p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="font-mono text-[10px] font-medium px-2 py-0.5 rounded-full bg-gold-soft text-gold-2">TIDY-UP · {items.length}</span>
        <span className="text-[12.5px] text-ink-3 flex-1"><span className="hidden lg:inline">Suggestions only — nothing changes until you tap.</span></span>
        {items.length > 1 && (
          <button type="button" onClick={() => setAll(a => !a)} className={`min-h-[36px] px-2 font-mono text-[11px] text-gold-2 ${items.length <= 3 ? 'lg:hidden' : ''}`}>
            {all ? 'Show fewer' : `Show all ${items.length}`}
          </button>
        )}
      </div>
      <div className="grid gap-2 lg:grid-cols-3">
        {shown.map((t, i) => {
          const w = tidyText(t)
          return (
            // A phone shows one at a time until "Show all".
            <div key={t.key} className={`bg-paper border border-line rounded-[11px] p-3 flex-col gap-1.5 ${i > 0 && !all ? 'hidden lg:flex' : 'flex'}`}>
              <span className="text-[13px] font-semibold leading-[1.35]">{w.head}</span>
              <span className="text-[12.5px] text-ink-3 leading-[1.4] flex-1">{w.body}</span>
              <span className="flex gap-1.5 pt-1">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={async () => { setBusy(t.key); await onAct(t); setBusy(null) }}
                  className="min-h-[40px] px-3 rounded-[9px] bg-ink text-paper text-[12.5px] font-medium disabled:opacity-50"
                >
                  {busy === t.key ? 'Saving…' : w.action}
                </button>
                <button type="button" onClick={() => onDismiss(t)} className="min-h-[40px] px-3 rounded-[9px] border border-line-2 text-[12.5px] text-ink-2">
                  Not this
                </button>
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
