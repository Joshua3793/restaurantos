'use client'
// Recipe Scan — the scanned method (design: MethodStep), in the shape the
// recipe editor uses: numbered steps under phase names, each with hands-on
// minutes and an optional wait after it. Times the page didn't state carry an
// amber GUESSED pill until the chef edits them; stated ones say "from page".
// Steps can be edited, reordered, split, merged and deleted; a phase can be
// renamed or started at any step.
import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Hourglass, MoreHorizontal, Scissors, Merge, Trash2, Tag, X } from 'lucide-react'
import { Pill } from '@/components/ui/Pill'
import { validateMethod, type MethodStep } from '@/lib/recipe-method'
import type { DraftData } from '@/lib/recipe-scan/types'
import {
  phaseRuns, patchStep, moveStep, splitStep, mergeWithNext, deleteStep, renamePhase, startPhaseAt,
  addStepAtEnd, timeSummary, formatMinutes, type MethodState,
} from '@/lib/recipe-scan/review'

interface Props {
  method: MethodStep[]
  guessed: DraftData['guessed']
  onChange: (next: MethodState) => void
}

const pad = (i: number) => String(i + 1).padStart(2, '0')

/** Grow a step's text box to its content, so a long step never hides behind a scrollbar on the phone. */
function fitHeight(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function runTotals(steps: MethodStep[]): string {
  const hands = steps.reduce((a, s) => a + (s.minutes ?? 0), 0)
  const wait = steps.reduce((a, s) => a + (s.wait?.minutes ?? 0), 0)
  const parts: string[] = []
  if (hands) parts.push(`${formatMinutes(hands)} hands-on`)
  if (wait) parts.push(`${formatMinutes(wait)} wait`)
  return parts.join(' · ')
}

function PhaseHeader({ name, totals, first, onRename }: {
  name: string
  totals: string
  first: boolean
  onRename: (name: string) => void
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 px-3 md:px-4 pt-3 pb-0.5 ${first ? '' : 'border-t border-line'}`}>
      <input
        key={name}
        defaultValue={name}
        placeholder="Name this phase"
        aria-label="Phase name"
        onBlur={e => { if (e.target.value.trim() !== name) onRename(e.target.value) }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="min-w-0 flex-1 bg-transparent font-mono text-[10px] uppercase tracking-[0.08em] text-ink outline-none border-b border-transparent hover:border-line focus:border-ink-3 placeholder:text-ink-4 placeholder:normal-case placeholder:tracking-normal"
      />
      {totals && <span className="font-mono text-[10px] text-ink-3 whitespace-nowrap">{totals}</span>}
    </div>
  )
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-7 px-1.5 rounded-md inline-flex items-center gap-1 text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-30 disabled:hover:bg-transparent font-mono text-[10px] uppercase"
    >
      {children}
    </button>
  )
}

interface StepProps {
  step: MethodStep
  index: number
  total: number
  guessed: { minutes?: true; wait?: true } | undefined
  /** The chef changed this step's hands-on time on this visit (so it is no longer "from page"). */
  edited: boolean
  onPatch: (p: Partial<Pick<MethodStep, 'text' | 'minutes' | 'wait'>>) => void
  onMove: (dir: -1 | 1) => void
  onSplit: (at: number | null) => void
  onMerge: () => void
  onDelete: () => void
  onNewPhase: () => void
}

function StepRow({ step, index, total, guessed, edited, onPatch, onMove, onSplit, onMerge, onDelete, onNewPhase }: StepProps) {
  const [open, setOpen] = useState(false)
  const caret = useRef<number | null>(null)
  const last = index === total - 1
  const minutes = step.minutes ?? 0

  const actions = (
    <>
      <IconBtn label="Move up" onClick={() => onMove(-1)} disabled={index === 0}><ArrowUp size={12} /></IconBtn>
      <IconBtn label="Move down" onClick={() => onMove(1)} disabled={last}><ArrowDown size={12} /></IconBtn>
      <IconBtn label="Split this step" onClick={() => onSplit(caret.current)}><Scissors size={12} />Split</IconBtn>
      <IconBtn label="Merge with the next step" onClick={onMerge} disabled={last}><Merge size={12} />Merge</IconBtn>
      {!step.wait && (
        <IconBtn label="Add a wait after this step" onClick={() => onPatch({ wait: { minutes: 30 } })} disabled={last}>
          <Hourglass size={12} />Wait
        </IconBtn>
      )}
      <IconBtn label="Start a new phase here" onClick={onNewPhase}><Tag size={12} />Phase</IconBtn>
      <IconBtn label="Delete this step" onClick={onDelete}><Trash2 size={12} /></IconBtn>
    </>
  )

  return (
    <div className="group">
      <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] md:grid-cols-[26px_minmax(0,1fr)_auto] gap-x-3 px-3 md:px-4 py-2.5">
        <span className="font-mono text-[11.5px] text-ink-4 pt-[5px]">{pad(index)}</span>
        <div className="min-w-0">
          <textarea
            key={`${step.key}:${step.text}`}
            defaultValue={step.text}
            rows={1}
            ref={fitHeight}
            onInput={e => fitHeight(e.currentTarget)}
            aria-label={`Step ${index + 1}`}
            onSelect={e => { const t = e.target as HTMLTextAreaElement; caret.current = t.selectionStart }}
            onBlur={e => {
              const v = e.target.value.trim()
              if (!v) { e.target.value = step.text; return } // a step can't be blank
              if (v !== step.text) onPatch({ text: v })
            }}
            className="w-full resize-none overflow-hidden bg-transparent text-[14px] leading-[1.5] text-ink-2 outline-none rounded-[6px] px-1 -mx-1 py-0.5 border border-transparent hover:border-line focus:border-ink-3 focus:bg-paper"
          />
          <div className="font-mono text-[10.5px] text-ink-3 mt-1 flex gap-2 items-center flex-wrap uppercase">
            <input
              key={`${step.key}:m:${minutes}`}
              type="number" min={0} step={1} inputMode="numeric"
              defaultValue={minutes || ''}
              placeholder="—"
              aria-label={`Hands-on minutes for step ${index + 1}`}
              onBlur={e => {
                const v = e.target.value.trim()
                const n = v === '' ? 0 : Math.round(Number(v))
                if (Number.isFinite(n) && n >= 0 && n !== minutes) onPatch({ minutes: n > 0 ? n : undefined })
              }}
              className="w-[46px] font-mono text-[11px] text-right bg-paper border border-line rounded-[6px] px-1.5 py-0.5 outline-none focus:border-ink-3"
            />
            <span>min hands-on</span>
            {minutes > 0 && (guessed?.minutes ? <Pill tone="gold">Guessed</Pill> : <span>· {edited ? 'edited' : 'from page'}</span>)}
            {minutes === 0 && <span className="text-ink-4">· untimed</span>}
            {/* Desktop: the step's tools sit at the end of this line, shown on hover. */}
            <span className="hidden md:flex items-center gap-0.5 ml-auto normal-case opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              {actions}
            </span>
          </div>
        </div>
        <div className="flex items-start">
          <button
            type="button"
            aria-label="Step actions"
            aria-expanded={open}
            onClick={() => setOpen(o => !o)}
            className="md:hidden h-7 w-7 grid place-items-center rounded-md text-ink-3 hover:bg-bg-2"
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
      </div>

      {open && (
        <div className="flex md:hidden flex-wrap items-center gap-0.5 px-3 -mt-1 pb-1.5">{actions}</div>
      )}

      {step.wait && (
        <div className="ml-3 mr-3 md:ml-[54px] md:mr-4 mb-2.5 px-3 py-2 border border-dashed border-line-2 rounded-[10px] font-mono text-[11px] text-ink-2 flex items-center gap-2 flex-wrap uppercase">
          <span className="w-[6px] h-[6px] rounded-full bg-gold shrink-0" />
          <span>Wait</span>
          <input
            key={`${step.key}:w:${step.wait.minutes}`}
            type="number" min={1} step={1} inputMode="numeric"
            defaultValue={step.wait.minutes}
            aria-label={`Wait minutes after step ${index + 1}`}
            onBlur={e => {
              const n = Math.round(Number(e.target.value))
              if (Number.isFinite(n) && n >= 1 && n !== step.wait!.minutes) onPatch({ wait: { ...step.wait!, minutes: n } })
              else e.target.value = String(step.wait!.minutes)
            }}
            className="w-[58px] font-mono text-[11px] text-right bg-paper border border-line rounded-[6px] px-1.5 py-0.5 outline-none focus:border-ink-3"
          />
          <span>min ·</span>
          <input
            key={`${step.key}:n:${step.wait.note ?? ''}`}
            defaultValue={step.wait.note ?? ''}
            placeholder="where — e.g. in the oven"
            aria-label={`Where the wait after step ${index + 1} happens`}
            onBlur={e => {
              const note = e.target.value.trim()
              if (note !== (step.wait!.note ?? '')) {
                const w = { minutes: step.wait!.minutes, ...(note ? { note } : {}) }
                onPatch({ wait: w })
              }
            }}
            className="flex-1 min-w-[120px] bg-transparent font-mono text-[11px] uppercase text-ink-2 outline-none border-b border-transparent hover:border-line focus:border-ink-3 placeholder:normal-case placeholder:text-ink-4"
          />
          {guessed?.wait && <Pill tone="gold">Guessed</Pill>}
          <button type="button" aria-label="Remove the wait" onClick={() => onPatch({ wait: undefined })} className="text-ink-4 hover:text-red-text">
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

export function MethodReview({ method, guessed, onChange }: Props) {
  const [edited, setEdited] = useState<Set<string>>(() => new Set())
  const box = useRef<HTMLElement | null>(null)
  // Text boxes re-fit when the screen width changes (phone rotation, window resize).
  useEffect(() => {
    const refit = () => box.current?.querySelectorAll('textarea').forEach(t => fitHeight(t))
    window.addEventListener('resize', refit)
    return () => window.removeEventListener('resize', refit)
  }, [])
  const st: MethodState = { method, guessed: guessed ?? {} }
  const runs = phaseRuns(method)
  const named = runs.filter(r => r.phase).length
  const time = timeSummary(method, guessed ?? {})
  const v = validateMethod(method)
  const endsOnWait = method.length > 0 && !!method[method.length - 1].wait

  const add = () => onChange(addStepAtEnd(st, `Step ${method.length + 1}`))

  return (
    <section ref={box} className="bg-paper border border-line rounded-lg overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 md:px-4 py-[13px] border-b border-line">
        <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink flex items-baseline gap-2">
          Method
          <span className="font-mono text-[10.5px] text-ink-3 font-normal">
            · {method.length} {method.length === 1 ? 'step' : 'steps'}{named > 0 && <> · {named} {named === 1 ? 'phase' : 'phases'}</>}
          </span>
        </h3>
        {(time.handsOn > 0 || time.wait > 0) && (
          <span className="font-mono text-[10.5px] text-ink-3 uppercase tracking-[0.03em] text-right">
            {formatMinutes(time.handsOn)} hands-on{time.wait > 0 && <> · {formatMinutes(time.wait)} wait</>}
          </span>
        )}
      </div>

      {method.length === 0 && (
        <div role="status" className="mx-3 md:mx-4 my-3 px-3 py-2.5 rounded-[10px] bg-gold-soft text-gold-2 text-[13px] font-medium">
          No method was read — add the steps, or discard and scan again.
        </div>
      )}

      {runs.map((run, r) => (
        <div key={`${run.start}:${run.phase}`}>
          {(run.phase || runs.length > 1) && (
            <PhaseHeader
              name={run.phase}
              first={r === 0}
              totals={runTotals(method.slice(run.start, run.end))}
              onRename={name => onChange(renamePhase(st, run.start, name))}
            />
          )}
          {method.slice(run.start, run.end).map((step, k) => {
            const i = run.start + k
            return (
              <StepRow
                key={step.key}
                step={step}
                index={i}
                total={method.length}
                guessed={guessed?.[step.key]}
                edited={edited.has(step.key)}
                onPatch={p => {
                  if ('minutes' in p) setEdited(e => new Set(e).add(step.key))
                  onChange(patchStep(st, i, p))
                }}
                onMove={dir => onChange(moveStep(st, i, dir))}
                onSplit={at => onChange(splitStep(st, i, at))}
                onMerge={() => onChange(mergeWithNext(st, i))}
                onDelete={() => onChange(deleteStep(st, i))}
                onNewPhase={() => onChange(startPhaseAt(st, i, 'New phase'))}
              />
            )
          })}
        </div>
      ))}

      {endsOnWait && (
        <div className="mx-3 md:mx-4 mb-3 px-3 py-2 rounded-[10px] bg-red-soft text-red-text text-[12.5px] flex items-center justify-between gap-3 flex-wrap">
          <span>A wait can&apos;t be the last thing — the job ends with the step that logs the yield.</span>
          <button type="button" onClick={() => onChange(addStepAtEnd(st, 'Label and date.'))} className="font-medium underline">
            Add &ldquo;Label and date&rdquo;
          </button>
        </div>
      )}
      {!v.ok && !endsOnWait && <p className="mx-3 md:mx-4 mb-3 text-[12.5px] text-red-text">{v.error}</p>}

      <div className="px-3 md:px-4 py-2.5 border-t border-line">
        <button type="button" onClick={add} className="text-[12.5px] font-medium text-ink-2 hover:text-ink">+ Add step</button>
      </div>
    </section>
  )
}
