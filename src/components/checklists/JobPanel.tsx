'use client'
import { useEffect, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { LineAction } from '@/lib/checklists/apply-line'
import type { RecentEntry } from '@/lib/checklists/history-types'
import { inRange, pacificHHMM, type Phase } from '@/lib/checklists/rules'
import { LineEditor } from './LineSheet'
import { Pill, firstName, fmtReading, rangeText, unitOf, type RowLine } from './LineRow'

// The desktop job panel: the job picked on the list, with the same controls as
// the phone's sheet (tick, log a reading, flag, untick), plus the last 7 days
// of the same job — who did it and what it read. A save moves on to the next
// job still to do, so a cook can work down the list from the keyboard.

/** '2026-10-31' → 'Sat'. */
function weekday(date: string): string {
  return new Date(date + 'T12:00:00Z').toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' })
}

function entryText(e: RecentEntry, unit: string): string {
  if (e.status === 'TODO') return 'not done'
  const parts = [firstName(e.byName) || 'someone']
  if (e.value != null) parts.push(fmtReading(e.value, unit))
  if (e.status === 'FLAGGED') parts.push('flagged')
  return parts.join(' · ')
}

function Recent({ line }: { line: RowLine }) {
  const [entries, setEntries] = useState<RecentEntry[] | null>(null)
  const lineId = line.id
  useEffect(() => {
    let cancelled = false
    setEntries(null)
    ;(async () => {
      try {
        const res = await fetch(`/api/checklists/lines/${lineId}/recent`, { cache: 'no-store' })
        const data = res.ok ? ((await res.json().catch(() => null)) as { entries?: RecentEntry[] } | null) : null
        if (!cancelled) setEntries(data?.entries ?? [])
      } catch {
        // The history is a hint, never a blocker.
        if (!cancelled) setEntries([])
      }
    })()
    return () => { cancelled = true }
  }, [lineId])

  if (!entries) return <p className="m-0 font-mono text-[10.5px] text-ink-4">Loading the last 7 days…</p>
  if (entries.length === 0) return <p className="m-0 text-[12.5px] text-ink-3">First time on the list — no earlier days yet.</p>

  const unit = unitOf(line)
  const readings = [...entries].reverse().filter(e => e.value != null)
  const top = Math.max(...readings.map(e => Math.abs(e.value as number)), line.safeMax ?? 0, 1)
  const range = rangeText(line.safeMin, line.safeMax, unit)

  return (
    <div className="flex flex-col gap-2.5">
      {line.answer !== 'TICK' && readings.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-end gap-1.5 h-12" aria-label={`Last ${readings.length} readings`}>
            {readings.map(e => {
              const bad = e.status === 'FLAGGED' || !inRange(e.value as number, line.safeMin, line.safeMax)
              const h = Math.max(4, Math.round((Math.abs(e.value as number) / top) * 44))
              return (
                <span key={e.date} className="flex-1 flex flex-col items-center gap-1" title={`${weekday(e.date)} · ${fmtReading(e.value as number, unit)}`}>
                  <span className={`w-full rounded-[3px] ${bad ? 'bg-red' : 'bg-line-2'}`} style={{ height: h }} />
                </span>
              )
            })}
          </div>
          <div className="flex gap-1.5">
            {readings.map(e => (
              <span key={e.date} className="flex-1 text-center font-mono text-[9px] text-ink-4">{weekday(e.date).charAt(0)}</span>
            ))}
          </div>
          {range && <span className="font-mono text-[10px] text-ink-3">SAFE {range.toUpperCase()}</span>}
        </div>
      )}
      <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
        {entries.slice(0, 3).map(e => (
          <li key={e.date} className="flex items-baseline gap-2 text-[12.5px]">
            <span className="w-8 flex-none font-mono text-[10.5px] text-ink-3">{weekday(e.date)}</span>
            <span className={`flex-1 min-w-0 truncate ${e.status === 'TODO' ? 'text-ink-4' : e.status === 'FLAGGED' ? 'text-red-text' : 'text-ink-2'}`}>
              {entryText(e, unit)}
            </span>
            {e.at && <span className="flex-none font-mono text-[10.5px] text-ink-3">{pacificHHMM(new Date(e.at)).replace(/^0/, '')}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function JobPanel({
  line,
  phase,
  placeLabel,
  locked,
  onAction,
  onNext,
}: {
  line: RowLine | null
  phase: Phase
  placeLabel: string
  /** The job's run is signed off: show it, offer nothing. */
  locked: boolean
  onAction: (line: RowLine, action: LineAction) => Promise<boolean>
  /** Select the next job still to do. */
  onNext: () => void
}) {
  if (!line) {
    return (
      <section aria-label="Job" className="bg-paper border border-line rounded-[14px] px-[18px] py-4 text-[14px] text-ink-3">
        Pick a job on the list to see how it’s done and who did it last.
      </section>
    )
  }
  return (
    <section aria-label={line.title} className="bg-paper border border-line rounded-[14px] flex flex-col">
      <div className="px-[18px] py-4 flex flex-col gap-4">
        {locked ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-1.5"><Pill tone="green">SIGNED OFF</Pill><Pill>{placeLabel.toUpperCase()}</Pill></div>
            <h2 className="m-0 text-[20px] leading-[1.2] font-semibold tracking-[-0.03em]">{line.title}</h2>
            {line.howTo && <p className="m-0 text-[14px] leading-[1.5] text-ink-2 whitespace-pre-line">{line.howTo}</p>}
            <p className="m-0 text-[12.5px] text-ink-3">This list is signed off. A lead can reopen it to change anything.</p>
          </div>
        ) : (
          // Remount on a new job or a new answer so the reading box and flag chips start fresh.
          <LineEditor
            key={`${line.id}:${line.status}`}
            line={line}
            phase={phase}
            placeLabel={placeLabel}
            onAction={onAction}
            onSaved={onNext}
            showLast={false}
            autoFocus={false}
          />
        )}
      </div>
      <div className="border-t border-line px-[18px] py-3.5 flex flex-col gap-2.5">
        <span className="font-mono text-[10px] font-medium tracking-[0.08em] text-ink-3">LAST 7 DAYS</span>
        <Recent line={line} />
      </div>
      <div className="border-t border-line px-[18px] py-3 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onNext}
          className="min-h-[40px] px-3.5 rounded-[9px] border border-line-2 bg-paper text-[13px] font-medium text-ink inline-flex items-center gap-1.5"
        >
          Next job <ArrowDown size={14} aria-hidden />
        </button>
        <span className="flex items-center gap-1.5 text-[11.5px] text-ink-3 flex-wrap">
          <Kbd>↑</Kbd><Kbd>↓</Kbd> move <Kbd>Space</Kbd> tick <Kbd>F</Kbd> flag <Kbd>0–9</Kbd> reading
        </span>
      </div>
    </section>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="font-mono text-[10px] px-1.5 py-px rounded-[5px] border border-line-2 border-b-2 bg-paper text-ink-2">{children}</kbd>
  )
}
