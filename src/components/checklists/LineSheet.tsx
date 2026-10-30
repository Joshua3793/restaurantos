'use client'
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import type { LineAction } from '@/lib/checklists/apply-line'
import { NOTE_MAX } from '@/lib/checklists/apply-line'
import { inRange, parseReading, type Phase } from '@/lib/checklists/rules'
import { lastTimeLabel } from '@/lib/checklists/format'
import type { LastReading } from '@/lib/checklists/history-types'
import { Pill, firstName, fmtReading, rangeText, unitOf, type RowLine } from './LineRow'

// "Log a number or flag a problem" — the bottom sheet for one job.
//
// Ruling R8: a NUMBER/TEMP line that already holds a reading (DONE, or flagged
// OUT_OF_RANGE with a value) opens with the number filled in to change it, and
// offers Untick instead of the flag chips — a manual flag would delete the
// logged Temps reading. Flag chips show only on lines with no reading. A done
// TICK line's sheet offers Untick only.

type Reason = 'BROKEN' | 'RAN_OUT' | 'OTHER'
/** "4" ↔ "-4". iPhone's decimal keypad has no minus key, so freezer readings need this (ruling R9). */
function flipSign(raw: string): string {
  const t = raw.trim()
  return t.startsWith('-') ? t.slice(1) : `-${t}`
}

const REASONS: { key: Reason; label: string }[] = [
  { key: 'BROKEN', label: 'Broken' },
  { key: 'RAN_OUT', label: 'Ran out' },
  { key: 'OTHER', label: 'Other…' },
]

/** True when a NUMBER/TEMP line holds a logged reading (R8). */
export function holdsReading(line: RowLine): boolean {
  if (line.answer === 'TICK' || line.value == null) return false
  return line.status === 'DONE' || (line.status === 'FLAGGED' && line.flagReason === 'OUT_OF_RANGE')
}

export function LineSheet({
  line,
  phase,
  placeLabel,
  onClose,
  onAction,
}: {
  line: RowLine
  phase: Phase
  /** Station name, or the whole-kitchen station's name, for the pill. */
  placeLabel: string
  onClose: () => void
  /** Sends the action; resolves true when it saved. */
  onAction: (line: RowLine, action: LineAction) => Promise<boolean>
}) {
  const isTick = line.answer === 'TICK'
  const unit = unitOf(line)
  const reading = holdsReading(line)
  const manualFlag = line.status === 'FLAGGED' && line.flagReason !== 'OUT_OF_RANGE'
  const tickDone = isTick && line.status === 'DONE'

  const [raw, setRaw] = useState(reading && line.value != null ? String(line.value) : '')
  const [reason, setReason] = useState<Reason | null>(
    manualFlag && line.flagReason && line.flagReason !== 'OUT_OF_RANGE' ? line.flagReason : null,
  )
  const [note, setNote] = useState(manualFlag ? line.flagNote ?? '' : '')
  const [busy, setBusy] = useState(false)
  // What this job read last time. Shown for readings only; silent while loading, when
  // there is none, and when the request fails — it is a hint, never a blocker.
  const [last, setLast] = useState<LastReading | null>(null)

  const lineId = line.id
  useEffect(() => {
    if (isTick) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/checklists/lines/${lineId}/last`, { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json().catch(() => null)) as LastReading | null
        if (!cancelled && data && typeof data.value === 'number') setLast(data)
      } catch { /* ignore: the hint is optional */ }
    })()
    return () => { cancelled = true }
  }, [lineId, isTick])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (action: LineAction) => {
    if (busy) return
    setBusy(true)
    const ok = await onAction(line, action)
    setBusy(false)
    if (ok) onClose()
  }

  const value = parseReading(raw)
  const range = rangeText(line.safeMin, line.safeMax, unit)
  const ok = value != null && inRange(value, line.safeMin, line.safeMax)
  let hint: { text: string; tone: string } | null = null
  if (value == null) {
    hint = range ? { text: `Safe ${range}`, tone: 'text-ink-3' } : null
  } else if (ok) {
    hint = range ? { text: `In range · safe ${range}`, tone: 'text-green-text' } : null
  } else if (line.safeMax != null && value > line.safeMax) {
    hint = { text: `Above ${fmtReading(line.safeMax, unit)} — saves as a problem`, tone: 'text-red-text' }
  } else if (line.safeMin != null) {
    hint = { text: `Below ${fmtReading(line.safeMin, unit)} — saves as a problem`, tone: 'text-red-text' }
  }

  const showFlag = isTick ? !tickDone : !reading
  const showUntick = tickDone || reading || manualFlag

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="presentation">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={line.title}
        className="relative w-full max-w-[480px] bg-paper rounded-t-[22px] px-4 pt-2.5 pb-[calc(20px+env(safe-area-inset-bottom))] flex flex-col gap-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="self-center w-10 h-1 rounded-full bg-line-2" />

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-1.5">
            {line.isBlocker && <Pill tone="red">{phase === 'OPEN' ? 'BEFORE DOORS' : 'BEFORE YOU LEAVE'}</Pill>}
            <Pill>{placeLabel.toUpperCase()}</Pill>
          </div>
          <h2 className="m-0 text-[20px] leading-[1.2] font-semibold tracking-[-0.03em]">{line.title}</h2>
          {line.howTo && <p className="m-0 text-[14px] leading-[1.5] text-ink-2 whitespace-pre-line">{line.howTo}</p>}
        </div>

        {!isTick && (
          <>
            <label className="flex flex-col gap-2">
              <span className="font-mono text-[10px] font-medium tracking-[0.08em] text-ink-3">READING</span>
              <span className="flex items-center gap-2.5 border-2 border-ink rounded-xl px-4 h-16">
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  autoFocus={!reading}
                  value={raw}
                  onChange={e => setRaw(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && value != null) run({ action: 'value', raw }) }}
                  aria-label={unit ? `Reading in ${unit}` : 'Reading'}
                  className="flex-1 min-w-0 border-0 outline-none bg-transparent font-mono text-[30px] font-semibold tracking-[-0.04em] text-ink"
                />
                {unit && <span className="font-mono text-[18px] text-ink-3">{unit}</span>}
                <button
                  type="button"
                  onClick={() => setRaw(flipSign)}
                  aria-label={value != null && value < 0 ? 'Make positive' : 'Make negative'}
                  className="flex-none -mr-2 w-11 h-11 rounded-[10px] bg-bg-2 grid place-items-center font-mono text-[20px] font-semibold text-ink-2"
                >
                  ±
                </button>
              </span>
              {hint && <span className={`font-mono text-[11px] ${hint.tone}`}>{hint.text}</span>}
            </label>
            <button
              type="button"
              disabled={value == null || busy}
              onClick={() => run({ action: 'value', raw })}
              className="h-[50px] rounded-xl bg-ink text-paper text-[14px] font-medium inline-flex items-center justify-center gap-1.5 disabled:bg-bg-2 disabled:text-ink-3"
            >
              {value == null
                ? 'Enter a reading'
                : <>Save {fmtReading(value, unit)} {ok ? 'and tick' : 'as a problem'} <Check size={16} strokeWidth={3} className="text-gold" aria-hidden /></>}
            </button>
          </>
        )}

        {isTick && !tickDone && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run({ action: 'tick' })}
            className="h-[50px] rounded-xl bg-ink text-paper text-[14px] font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
          >
            Tick it done <Check size={16} strokeWidth={3} className="text-gold" aria-hidden />
          </button>
        )}

        {showUntick && (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => run({ action: 'untick' })}
              className="h-[50px] rounded-xl border border-line-2 bg-paper text-ink-2 text-[14px] font-medium disabled:opacity-60"
            >
              {manualFlag ? 'Clear the flag' : 'Untick'}
            </button>
            {reading && (
              <span className="text-center font-mono text-[10.5px] text-ink-3">Untick first to flag it instead</span>
            )}
          </div>
        )}

        {showFlag && (
          <div className="border-t border-line pt-3.5 flex flex-col gap-2.5">
            <div className="text-[14px] font-semibold tracking-[-0.01em]">Can’t do it? Flag it instead</div>
            <p className="m-0 text-[12.5px] leading-[1.45] text-ink-3">
              Shows on the manager’s screen. A flagged job counts as handled, so it won’t hold up your sign-off.
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Reason">
              {REASONS.map(r => {
                const on = reason === r.key
                return (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setReason(on ? null : r.key)}
                    className={`min-h-[44px] px-3.5 rounded-full text-[13px] border ${on ? 'border-red bg-red-soft text-red-text font-medium' : 'border-line-2 bg-paper text-ink-2'}`}
                  >
                    {r.label}
                  </button>
                )
              })}
            </div>
            {reason && (
              <>
                <textarea
                  rows={2}
                  maxLength={NOTE_MAX}
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="What happened? (optional)"
                  aria-label="Note for the manager"
                  className="border border-line-2 rounded-[9px] px-3 py-2.5 text-[14px] leading-[1.45] text-ink resize-none outline-none focus:border-ink-3"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run({ action: 'flag', reason, note: note.trim() || undefined })}
                  className="h-[50px] rounded-xl bg-red text-white text-[14px] font-medium disabled:opacity-60"
                >
                  Flag it · {REASONS.find(r => r.key === reason)?.label.replace('…', '')}
                </button>
              </>
            )}
          </div>
        )}

        {last && (
          <div className="flex items-center gap-2.5 bg-bg-2 rounded-[10px] px-3 py-2.5">
            <span className="flex-none font-mono text-[10px] tracking-[0.08em] text-ink-3">LAST TIME</span>
            <span className="min-w-0 font-mono text-[11px] text-ink-2">
              {[
                fmtReading(last.value, unitOf({ answer: line.answer, unit: last.unit })),
                firstName(last.byName),
                lastTimeLabel(last.at),
              ].filter(Boolean).join(' · ')}
            </span>
          </div>
        )}
      </section>
    </div>
  )
}
