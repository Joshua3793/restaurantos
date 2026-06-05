'use client'
import { useState } from 'react'
import { Check, X, ArrowRight, AlertTriangle, Pencil } from 'lucide-react'

export type MTint = 'ok' | 'warn' | 'bad' | 'neutral'

export function MGateBanner({ blockersOpen, ready }: { blockersOpen: number; ready: boolean }) {
  if (ready) {
    return (
      <div className="bg-green-soft text-green-text rounded-xl px-3.5 py-2.5 flex items-center gap-2 text-[13px] font-semibold mb-3">
        <Check size={17} strokeWidth={2.4} /> Ready for service
      </div>
    )
  }
  return (
    <div className="bg-red-soft text-red-text rounded-xl px-3.5 py-2.5 flex items-center gap-2 text-[13px] font-semibold mb-3">
      <AlertTriangle size={17} />
      {blockersOpen > 0
        ? `${blockersOpen} blocker${blockersOpen > 1 ? 's' : ''} — service can't open`
        : 'Finish the checks to open'}
    </div>
  )
}

export function MProgress({ done, total, pct, countdown, countdownLabel }: {
  done: number; total: number; pct: number; countdown: string | null; countdownLabel: string | null
}) {
  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="font-mono text-[11px] text-ink-3">
          <b className="text-ink font-semibold text-[13px]">{done}</b>/{total} done
        </span>
        {countdown && (
          <span className="font-mono text-[11px] text-gold-2 font-semibold">
            {countdown}{countdownLabel ? ` · ${countdownLabel}` : ''}
          </span>
        )}
      </div>
      <div className="h-2 rounded-full bg-bg-2 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-300 ${pct === 100 ? 'bg-green' : 'bg-gold'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function MSectionCard({ title, done, total, children }: {
  title: string; done: number; total: number; children: React.ReactNode
}) {
  const complete = total > 0 && done === total
  return (
    <section className="bg-paper border border-line rounded-xl overflow-hidden mb-3">
      <header className="flex items-center justify-between px-3.5 py-2.5 border-b border-line bg-bg-2">
        <h3 className="text-[12.5px] font-semibold tracking-[-0.01em]">{title}</h3>
        <span className={`font-mono text-[10.5px] ${complete ? 'text-green-text' : 'text-ink-3'}`}>{done} / {total}</span>
      </header>
      {children}
    </section>
  )
}

export function MCheckRow({ title, meta, metaAlert, done, right, rightTint, onToggle, onEdit, onDelete }: {
  title: string
  meta?: string
  metaAlert?: string
  done: boolean
  right?: string
  rightTint?: MTint
  onToggle: () => void
  onEdit?: (title: string) => void
  onDelete?: () => void
}) {
  const tintClass = rightTint === 'bad' ? 'text-red-text' : rightTint === 'warn' ? 'text-gold-2' : rightTint === 'ok' ? 'text-green-text' : 'text-ink-3'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const editable = !!onEdit || !!onDelete
  const commit = () => { const t = draft.trim(); if (t) onEdit?.(t); setEditing(false) }
  return (
    <div className="flex items-center gap-3 px-3.5 py-3 border-b border-line last:border-0 active:bg-bg/60 group" onClick={() => { if (!editing) onToggle() }}>
      <div className={`w-[22px] h-[22px] rounded-[6px] border-[1.5px] grid place-items-center shrink-0 ${done ? 'bg-green border-green text-white' : 'border-line-2 text-transparent'}`}>
        <Check size={13} strokeWidth={3} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-[14px] font-medium tracking-[-0.01em] flex items-center gap-1.5 ${done ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink'}`}>
          {editing ? (
            <input
              autoFocus
              value={draft}
              onClick={e => e.stopPropagation()}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(title); setEditing(false) } }}
              onBlur={commit}
              className="flex-1 min-w-0 bg-bg border border-ink-3 rounded-[6px] px-2 py-1 text-[14px] text-ink outline-none"
            />
          ) : (
            <span className="truncate">{title}</span>
          )}
        </div>
        {(meta || metaAlert) && !editing && (
          <div className="font-mono text-[10px] text-ink-3 mt-[3px] flex items-center gap-1.5 flex-wrap">
            {meta}
            {meta && metaAlert && <span className="text-ink-4">·</span>}
            {metaAlert && <b className="text-red-text font-semibold">{metaAlert}</b>}
          </div>
        )}
      </div>
      {editable && !editing ? (
        <div className="flex items-center gap-2.5 shrink-0">
          <button onClick={e => { e.stopPropagation(); setDraft(title); setEditing(true) }} className="text-ink-4 active:text-ink" aria-label="Edit"><Pencil size={15} /></button>
          <button onClick={e => { e.stopPropagation(); onDelete?.() }} className="text-ink-4 active:text-red-text" aria-label="Delete"><X size={15} /></button>
        </div>
      ) : (right && !editing && <span className={`font-mono text-[11px] font-semibold shrink-0 ${tintClass}`}>{right}</span>)}
    </div>
  )
}

export function MSignoff({ ready, onOpen }: { ready: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      disabled={!ready}
      className={`w-full h-[52px] rounded-2xl inline-flex items-center justify-center gap-2 text-[15px] font-semibold tracking-[-0.01em] mt-1 ${
        ready ? 'bg-green text-white' : 'bg-bg-2 text-ink-4 cursor-not-allowed'
      }`}
    >
      <ArrowRight size={18} strokeWidth={2.5} /> {ready ? 'Open service' : 'Mark ready for service'}
    </button>
  )
}
