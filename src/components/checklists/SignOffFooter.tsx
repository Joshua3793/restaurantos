'use client'
import { useState } from 'react'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import type { RunView } from '@/lib/checklists/runs'
import type { StationCard } from '@/lib/checklists/cook-view'
import { canSignOff, pacificHHMM, runProgress, type Phase } from '@/lib/checklists/rules'
import { firstName } from './LineRow'

// The bottom of the cook's list: on CLOSE a "Note for tomorrow's opener" card
// per station, then a sticky footer (above the phone tab bar) with one sign-off
// button per picked station. A signed run shows who signed and when, plus
// Reopen for a shift lead and up.

const HANDOVER_MAX = 1000

export function SignOffFooter({
  phase,
  runs,
  stations,
  canReopen,
  sharedBlockersOpen,
  onSignOff,
  onReopen,
}: {
  phase: Phase
  runs: RunView[]
  stations: StationCard[]
  canReopen: boolean
  /**
   * A whole-kitchen blocker is still to do. The lede and section header count
   * it, but sign-off does not, so the footer says "N of yours left" (ruling R10).
   */
  sharedBlockersOpen: boolean
  /** Resolves true when it saved. */
  onSignOff: (run: RunView, handoverNote: string | undefined) => Promise<boolean>
  onReopen: (run: RunView) => Promise<boolean>
}) {
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  // A reopened closing keeps its note: the box starts from it, so signing again does not wipe it.
  const noteOf = (r: RunView) => notes[r.id] ?? r.handoverNote ?? ''
  const nameOf = (r: RunView) => stations.find(s => s.id === r.stationId)?.name ?? 'station'
  const many = runs.length > 1

  const sign = async (run: RunView) => {
    if (busy) return
    setBusy(run.id)
    const ok = await onSignOff(run, phase === 'CLOSE' ? noteOf(run) : undefined)
    setBusy(null)
    if (ok) setNotes(prev => { const n = { ...prev }; delete n[run.id]; return n })
  }
  const reopen = async (run: RunView) => {
    if (busy) return
    setBusy(run.id)
    await onReopen(run)
    setBusy(null)
  }

  const openRuns = runs.filter(r => r.status === 'OPEN')

  return (
    <>
      {phase === 'CLOSE' && openRuns.map(run => {
        const name = nameOf(run)
        const id = `handover-${run.id}`
        return (
          <section key={run.id} aria-label="Hand over" className="mt-4 bg-paper border border-line rounded-[14px] px-4 py-3.5 flex flex-col gap-2.5">
            <label htmlFor={id} className="text-[15px] font-semibold tracking-[-0.015em]">
              Note for tomorrow’s opener{many && <span className="text-ink-3 font-medium"> · {name}</span>}
            </label>
            <textarea
              id={id}
              rows={3}
              maxLength={HANDOVER_MAX}
              value={noteOf(run)}
              onChange={e => setNotes(prev => ({ ...prev, [run.id]: e.target.value }))}
              placeholder="Low on anything? Something broken? Tell the opener."
              className="border border-line-2 rounded-[9px] px-3 py-2.5 text-[14px] leading-[1.45] text-ink resize-none outline-none focus:border-ink-3"
            />
            <span className="font-mono text-[10.5px] text-ink-3">SHOWS FIRST ON {name.toUpperCase()}’S OPENING LIST</span>
          </section>
        )
      })}

      {/* z-[56]: above the AI chat bubble (z-[55], same bottom offset), below the sheets (z-[60]). */}
      <footer className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] md:bottom-0 z-[56] mt-4 -mx-4 md:mx-0 px-4 py-3 bg-paper border-t border-line flex flex-col gap-2">
        {runs.map(run => {
          const name = nameOf(run)
          if (run.status === 'SIGNED') {
            const at = run.signedOffAt ? pacificHHMM(new Date(run.signedOffAt)) : ''
            return (
              <div key={run.id} className="flex items-center gap-2 min-h-[50px]">
                <CheckCircle2 size={18} className="text-green flex-none" aria-hidden />
                <span className="flex-1 min-w-0 font-mono text-[12px] text-green-text">
                  {many && `${name} · `}Signed off by {firstName(run.signedOffByName) || 'someone'}{at && ` · ${at}`}
                </span>
                {canReopen && (
                  <button
                    type="button"
                    disabled={busy === run.id}
                    onClick={() => reopen(run)}
                    className="flex-none min-h-[44px] px-4 rounded-[10px] border border-line-2 text-[13px] font-medium text-ink-2 disabled:opacity-60"
                  >
                    {busy === run.id ? 'Reopening…' : 'Reopen'}
                  </button>
                )}
              </div>
            )
          }
          const left = runProgress(run.lines).blockersLeft
          const ready = canSignOff(run.lines)
          const label = phase === 'OPEN'
            ? (many ? `Finish ${name} opening` : 'Finish opening')
            : `Sign off ${name}`
          if (!ready) {
            const why = run.lines.length === 0
              ? 'nothing to sign off'
              : sharedBlockersOpen
                ? `${left} of yours left`
                : phase === 'OPEN' ? `${left} before doors left` : `${left} left`
            return (
              <button key={run.id} type="button" disabled className="h-[50px] rounded-xl bg-bg-2 text-ink-3 text-[14px] font-medium">
                {label} · {why}
              </button>
            )
          }
          return (
            <button
              key={run.id}
              type="button"
              disabled={busy === run.id}
              onClick={() => sign(run)}
              className="h-[50px] rounded-xl bg-ink text-paper text-[14px] font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
            >
              {busy === run.id ? 'Signing off…' : <>{label} <ArrowRight size={16} className="text-gold" aria-hidden /></>}
            </button>
          )
        })}
        {phase === 'CLOSE' && openRuns.length > 0 && (
          <span className="text-center font-mono text-[10.5px] text-ink-3">YOUR NAME AND TIME ARE SAVED ON EVERY JOB</span>
        )}
      </footer>
    </>
  )
}
