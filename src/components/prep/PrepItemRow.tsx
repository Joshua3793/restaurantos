'use client'
import { useState, useRef, useEffect } from 'react'
import { X, Check, BookOpen, Play, RotateCcw } from 'lucide-react'
import { PREP_PRIORITY_META } from '@/lib/prep-utils'
import type { PrepItemRich } from './types'
import { RecipeViewModal } from './RecipeViewModal'

interface Props {
  item: PrepItemRich
  onClick: () => void
  onStatusChange: (itemId: string, status: string, actualQty?: number) => void
  onPriorityChange: (itemId: string, priority: string) => void
  onDelete: (itemId: string) => void
  onToggleOnList?: (itemId: string, newValue: boolean) => void
  showReason?: boolean
}

// New design language (matches SmartPrepCard): cool neutral + amber, canonical tokens.
// Priority → left edge accent + bar + badge colour.
const PRIORITY: Record<string, { edge: string; bar: string; badge: string; suggest: string; label: string }> = {
  '911':          { edge: 'border-l-red-500',  bar: 'bg-red-500',   badge: 'bg-red-100 text-red-700',   suggest: 'text-red-700',  label: 'Critical' },
  'NEEDED_TODAY': { edge: 'border-l-gold',     bar: 'bg-gold',      badge: 'bg-gold-soft text-gold-2',  suggest: 'text-gold-2',   label: 'Needed today' },
  'LATER':        { edge: 'border-l-line-2',   bar: 'bg-green-500', badge: 'bg-bg-2 text-ink-3',        suggest: 'text-green-700', label: 'Later' },
}

export function PrepItemRow({ item, onClick, onStatusChange, onPriorityChange, onDelete, onToggleOnList }: Props) {
  const [confirmingDone, setConfirmingDone] = useState(false)
  const [confirmQty, setConfirmQty]         = useState('')
  const [pendingStatus, setPendingStatus]   = useState<'DONE' | 'PARTIAL'>('DONE')
  const [showRecipe, setShowRecipe]         = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const currentStatus = item.todayLog?.status ?? 'NOT_STARTED'
  const isDone        = currentStatus === 'DONE'
  const isPartial     = currentStatus === 'PARTIAL'
  const isCompleted   = isDone || isPartial
  const isSkipped     = currentStatus === 'SKIPPED'
  const isInProgress  = currentStatus === 'IN_PROGRESS'
  const isBlocked     = currentStatus === 'BLOCKED'

  const p         = PRIORITY[item.priority] ?? { edge: 'border-l-line-2', bar: 'bg-bg-2', badge: 'bg-bg-2 text-ink-3', suggest: 'text-ink-3', label: item.priority }
  const isCritical = item.priority === '911'
  const stockPct  = item.parLevel > 0 ? Math.min(100, (item.onHand / item.parLevel) * 100) : 100
  const parPct    = item.parLevel > 0 ? Math.round((item.onHand / item.parLevel) * 100) : 100
  const fmtQty    = (n: number) => n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)

  useEffect(() => {
    if (confirmingDone && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [confirmingDone])

  function openDonePrompt(status: 'DONE' | 'PARTIAL') {
    setPendingStatus(status)
    setConfirmQty(item.suggestedQty > 0 ? item.suggestedQty.toFixed(1) : '')
    setConfirmingDone(true)
  }

  function handleConfirm() {
    const parsed = parseFloat(confirmQty)
    const qty = !isNaN(parsed) && parsed > 0 ? parsed : undefined
    onStatusChange(item.id, pendingStatus, qty)
    setConfirmingDone(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') setConfirmingDone(false)
    if (e.key === 'Enter')  handleConfirm()
  }

  const recipeModal = showRecipe && item.linkedRecipeId && (
    <RecipeViewModal
      recipeId={item.linkedRecipeId}
      recipeName={item.name}
      suggestedQty={item.suggestedQty > 0 ? item.suggestedQty : undefined}
      yieldUnit={item.unit}
      baseYieldQty={item.linkedRecipe?.baseYieldQty}
      checkedIngredients={new Set()}
      onToggleIngredient={() => {}}
      onClose={() => setShowRecipe(false)}
    />
  )

  // ── Qty entry prompt (log yield) ──────────────────────────────────────────
  if (confirmingDone) {
    const isDoneStatus = pendingStatus === 'DONE'
    return (
      <div className={`bg-paper border border-line border-l-[3px] ${isDoneStatus ? 'border-l-green-500' : 'border-l-gold'} rounded-[10px] p-3.5`}>
        <p className="font-mono text-[11px] text-ink-3 mb-2.5">
          {isDoneStatus ? 'HOW MUCH DID YOU MAKE?' : 'HOW MUCH WAS PARTIAL?'} <span className="text-ink-4">({item.unit})</span>
        </p>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="number"
            min="0"
            step="0.1"
            value={confirmQty}
            onChange={e => setConfirmQty(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-11 flex-1 rounded-[9px] border-2 border-gold px-3 text-[18px] font-semibold text-center text-ink focus:outline-none"
            placeholder={item.unit}
          />
          <button
            onClick={handleConfirm}
            className={`h-11 px-4 rounded-[9px] text-paper text-[13px] font-semibold inline-flex items-center gap-1.5 transition-colors ${
              isDoneStatus ? 'bg-ink hover:bg-ink-2' : 'bg-gold hover:bg-gold-2'
            }`}
          >
            {isDoneStatus ? <><Check size={14} className="text-gold" /> Done</> : <>◐ Partial</>}
          </button>
          <button
            onClick={() => setConfirmingDone(false)}
            className="h-11 w-10 grid place-items-center text-ink-4 hover:text-ink-2 hover:bg-bg-2 rounded-[9px]"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    )
  }

  // ── Skipped row ──────────────────────────────────────────────────────────
  if (isSkipped) {
    return (
      <div className="bg-bg-2/60 border border-line rounded-[10px] px-3.5 py-3 opacity-70">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-ink-4 flex-1 line-through truncate">{item.name}</span>
          <span className="font-mono text-[9.5px] text-ink-3 bg-bg-2 px-2 py-0.5 rounded-full shrink-0 uppercase tracking-[0.02em]">Removed</span>
        </div>
        <button
          onClick={() => onStatusChange(item.id, 'NOT_STARTED')}
          className="mt-2 font-mono text-[11px] text-ink-2 border border-line hover:border-ink-3 px-3 py-1.5 rounded-[8px] inline-flex items-center gap-1.5 transition-colors"
        >
          <RotateCcw size={11} /> Restore to list
        </button>
      </div>
    )
  }

  // ── Completed row (Done / Partial) ──────────────────────────────────────
  if (isCompleted) {
    return (
      <>
        <div className={`bg-paper border border-line border-l-[3px] ${isDone ? 'border-l-green-500' : 'border-l-gold'} rounded-[10px] px-3.5 py-3`}>
          <div className="flex items-center gap-2.5">
            <span className={`w-5 h-5 rounded-full grid place-items-center shrink-0 ${isDone ? 'bg-green-600' : 'bg-gold'}`}>
              {isDone
                ? <Check size={11} strokeWidth={3} className="text-white" />
                : <span className="text-white text-[10px] font-bold leading-none">◐</span>}
            </span>
            <button onClick={onClick} className="text-[14px] font-medium flex-1 line-through truncate text-left text-ink-3 hover:opacity-80">
              {item.name}
            </button>
            <span className="font-mono text-[11px] font-medium shrink-0 text-ink-2">
              {isDone ? 'Done' : 'Partial'}
              {item.todayLog?.actualPrepQty != null && (
                <span className="text-ink-3 ml-1">· {item.todayLog.actualPrepQty} {item.unit}</span>
              )}
            </span>
          </div>
          <div className="pl-[30px] mt-1.5">
            <button
              onClick={() => onStatusChange(item.id, 'NOT_STARTED')}
              className="font-mono text-[10.5px] text-ink-3 border border-line hover:border-ink-3 px-2.5 py-1 rounded-[7px] inline-flex items-center gap-1 transition-colors"
            >
              <RotateCcw size={10} /> Reset
            </button>
          </div>
        </div>
        {recipeModal}
      </>
    )
  }

  // ── Blocked row ──────────────────────────────────────────────────────────
  if (isBlocked) {
    return (
      <div className="bg-paper border border-[#fca5a5] border-l-[3px] border-l-red-500 rounded-[10px] px-3.5 py-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-[9.5px] font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 shrink-0 uppercase tracking-[0.02em]">Blocked</span>
          <button onClick={onClick} className="text-[14px] font-medium text-ink flex-1 truncate text-left">{item.name}</button>
        </div>
        {item.blockedReason && <p className="font-mono text-[11px] text-red-700 mb-2">{item.blockedReason}</p>}
        <button
          onClick={() => onStatusChange(item.id, 'IN_PROGRESS')}
          className="font-mono text-[11px] font-medium bg-bg-2 text-ink-2 border border-line hover:border-ink-3 px-3 py-1.5 rounded-[8px] inline-flex items-center gap-1.5 transition-colors"
        >
          <Play size={11} className="text-gold" fill="currentColor" /> Resume
        </button>
      </div>
    )
  }

  // ── Active row (NOT_STARTED / IN_PROGRESS) ──────────────────────────────
  const suggestionText = item.priority !== 'LATER'
    ? item.suggestedQty > 0
      ? `make ${fmtQty(item.suggestedQty)} ${item.unit}${item.priority === '911' ? ' — stock depleted' : ' — below par'}`
      : 'review stock'
    : 'at or above par — looking good'

  return (
    <>
      <div className={`bg-paper border ${isCritical ? 'border-[#fca5a5]' : 'border-line'} border-l-[3px] ${p.edge} rounded-[10px] p-3.5 flex flex-col gap-2.5`}>
        {/* Header: priority badge + name + status */}
        <div className="flex items-start justify-between gap-2.5">
          <button onClick={onClick} className="flex-1 min-w-0 text-left hover:opacity-80 transition-opacity">
            <div className="flex items-center gap-1.5 mb-1">
              <span className={`font-mono text-[9.5px] font-medium px-2 py-0.5 rounded-full shrink-0 uppercase tracking-[0.02em] ${p.badge}`}>
                {p.label}
              </span>
              {item.manualPriorityOverride && (
                <span className="font-mono text-[9.5px] text-gold-2 bg-gold-soft px-1.5 py-0.5 rounded-[4px] font-medium">✎ OVERRIDE</span>
              )}
            </div>
            <div className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink leading-[1.2] truncate">{item.name}</div>
          </button>

          <div className="flex items-center gap-1.5 shrink-0">
            {isInProgress ? (
              <span className="font-mono text-[9.5px] font-medium text-gold-2 bg-gold-soft px-2 py-0.5 rounded-full inline-flex items-center gap-1 uppercase tracking-[0.02em]">
                <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse inline-block" />
                In progress
              </span>
            ) : (
              <span className="font-mono text-[10px] text-ink-4">Not started</span>
            )}
            {item.linkedRecipeId && (
              <button
                onClick={e => { e.stopPropagation(); setShowRecipe(true) }}
                className="p-1 text-ink-4 hover:text-gold hover:bg-gold-soft rounded-[7px] transition-colors"
                title="View recipe"
              >
                <BookOpen size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Progress */}
        {item.parLevel > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between font-mono text-[11px] text-ink-3 gap-2 whitespace-nowrap">
              <span><b className="text-ink font-medium">{fmtQty(item.onHand)}</b> / {fmtQty(item.parLevel)} {item.unit} on hand</span>
              <span className={isCritical ? 'text-red-700' : item.priority === 'NEEDED_TODAY' ? 'text-gold-2' : 'text-ink-3'}>{parPct}% of par</span>
            </div>
            <div className="h-1.5 bg-bg-2 rounded-full overflow-hidden">
              <div className={`h-full ${p.bar} rounded-full transition-all`} style={{ width: `${Math.max(stockPct, isCritical && stockPct < 1 ? 1 : 0)}%` }} />
            </div>
          </div>
        )}

        {/* Suggestion */}
        {item.manualPriorityOverride ? (
          <div className="font-mono text-[11.5px] text-ink-3 line-through tracking-[0]">
            System suggests → {item.suggestedQty > 0 ? `make ${fmtQty(item.suggestedQty)} ${item.unit}` : 'review stock'}
          </div>
        ) : (
          <div className={`font-mono text-[11.5px] tracking-[0] flex items-center gap-1.5 ${item.priority !== 'LATER' ? p.suggest : 'text-green-700'}`}>
            {item.priority !== 'LATER' && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>
            )}
            <span><b className="font-semibold">{item.priority !== 'LATER' ? 'System suggests → ' : ''}</b>{suggestionText}{item.estimatedPrepTime && item.priority !== 'LATER' ? ` · ~${item.estimatedPrepTime} min` : ''}</span>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-1.5 pt-0.5" onClick={e => e.stopPropagation()}>
          {currentStatus === 'NOT_STARTED' && (
            <>
              <button
                onClick={() => onStatusChange(item.id, 'IN_PROGRESS')}
                className="flex-1 h-9 rounded-[9px] text-[12.5px] font-medium bg-bg-2 text-ink-2 border border-line hover:border-ink-3 transition-colors inline-flex items-center justify-center gap-1.5"
              >
                <Play size={11} className="text-gold" fill="currentColor" /> Start
              </button>
              <button
                onClick={() => openDonePrompt('DONE')}
                className="flex-1 h-9 rounded-[9px] text-[12.5px] font-semibold bg-ink text-paper hover:bg-ink-2 transition-colors inline-flex items-center justify-center gap-1.5"
              >
                <Check size={12} strokeWidth={3} className="text-gold" /> Done
              </button>
              <button
                onClick={() => onStatusChange(item.id, 'SKIPPED')}
                className="px-3 h-9 rounded-[9px] text-[12.5px] text-ink-3 border border-line hover:bg-bg-2 transition-colors"
                title="Remove from today's list"
              >
                Skip
              </button>
            </>
          )}

          {isInProgress && (
            <>
              <button
                onClick={() => openDonePrompt('DONE')}
                className="flex-1 h-9 rounded-[9px] text-[12.5px] font-semibold bg-ink text-paper hover:bg-ink-2 transition-colors inline-flex items-center justify-center gap-1.5"
              >
                <Check size={12} strokeWidth={3} className="text-gold" /> Done
              </button>
              <button
                onClick={() => openDonePrompt('PARTIAL')}
                className="flex-1 h-9 rounded-[9px] text-[12.5px] font-medium bg-gold-soft text-gold-2 border border-gold/30 hover:bg-[#fde68a] transition-colors"
              >
                ◐ Partial
              </button>
              <button
                onClick={() => onStatusChange(item.id, 'SKIPPED')}
                className="px-3 h-9 rounded-[9px] text-[12.5px] text-ink-3 border border-line hover:bg-bg-2 transition-colors"
                title="Remove from today's list"
              >
                Skip
              </button>
            </>
          )}
        </div>
      </div>

      {recipeModal}
    </>
  )
}
