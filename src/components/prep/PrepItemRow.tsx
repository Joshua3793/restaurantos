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

// Priority frames: left border accent + subtle bg tint
const PRIORITY_FRAME: Record<string, { border: string; bg: string }> = {
  '911':          { border: 'border-l-[4px] border-l-red-500',    bg: 'bg-red-50/30'    },
  'NEEDED_TODAY': { border: 'border-l-[4px] border-l-orange-400', bg: 'bg-orange-50/20' },
  'LATER':        { border: 'border-l-[4px] border-l-gray-200',   bg: ''                },
}

const PRIORITY_BADGE: Record<string, string> = {
  '911':          'bg-red-100 text-red-700',
  'NEEDED_TODAY': 'bg-orange-100 text-orange-700',
  'LATER':        'bg-gray-100 text-gray-600',
}

const PRIORITY_LABEL: Record<string, string> = {
  '911':          'Critical',
  'NEEDED_TODAY': 'Needed Today',
  'LATER':        'Later',
}

const PRIORITY_SUGGEST_COLOR: Record<string, string> = {
  '911':          'text-red-600',
  'NEEDED_TODAY': 'text-orange-600',
  'LATER':        'text-green-600',
}

const PRIORITY_BAR_COLOR: Record<string, string> = {
  '911':          'bg-red-400',
  'NEEDED_TODAY': 'bg-orange-400',
  'LATER':        'bg-green-400',
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

  const priority  = PREP_PRIORITY_META[item.priority]
  const frame     = PRIORITY_FRAME[item.priority] ?? { border: 'border-l-[4px] border-l-transparent', bg: '' }
  const stockPct  = item.parLevel > 0 ? Math.min(100, (item.onHand / item.parLevel) * 100) : 100
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

  // ── Qty entry prompt ──────────────────────────────────────────────────────
  if (confirmingDone) {
    const promptFrame = isDone || pendingStatus === 'DONE'
      ? 'border-l-[4px] border-l-green-500 bg-green-50/30'
      : 'border-l-[4px] border-l-amber-400 bg-amber-50/30'
    return (
      <div className={`px-3 py-3 border-b border-gray-50 ${promptFrame}`}>
        <p className="text-xs text-gray-500 mb-2">
          {pendingStatus === 'DONE' ? 'How much did you make?' : 'How much was partial?'}{' '}
          <span className="text-gray-400">({item.unit})</span>
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
            className="h-9 w-28 rounded-lg border border-gray-300 px-3 text-sm text-center focus:outline-none focus:ring-2 focus:ring-gold"
            placeholder={item.unit}
          />
          <button
            onClick={handleConfirm}
            className={`h-9 px-4 rounded-lg text-white text-sm font-semibold transition-colors ${
              pendingStatus === 'DONE' ? 'bg-green-600 hover:bg-green-700' : 'bg-amber-500 hover:bg-amber-600'
            }`}
          >
            {pendingStatus === 'DONE' ? '✓ Done' : '◐ Partial'}
          </button>
          <button
            onClick={() => setConfirmingDone(false)}
            className="h-9 px-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    )
  }

  // ── Skipped row ──────────────────────────────────────────────────────────
  if (isSkipped) {
    return (
      <div className="border-l-[4px] border-l-gray-200 border-b border-gray-50 opacity-50 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-400 flex-1 line-through truncate">{item.name}</span>
          <span className="text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full shrink-0">Removed</span>
        </div>
        <button
          onClick={() => onStatusChange(item.id, 'NOT_STARTED')}
          className="mt-1.5 text-xs text-gray-500 border border-gray-200 hover:bg-gray-100 px-3 py-1 rounded-lg transition-colors"
        >
          ↩ Restore to list
        </button>
      </div>
    )
  }

  // ── Completed row (Done / Partial) ──────────────────────────────────────
  if (isCompleted) {
    const completedFrame = isDone
      ? 'border-l-[4px] border-l-green-500 bg-green-50/40'
      : 'border-l-[4px] border-l-amber-400 bg-amber-50/40'
    return (
      <>
        <div className={`${completedFrame} border-b border-gray-50 px-3 py-2.5 opacity-70`}>
          <div className="flex items-center gap-2">
            <span className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${isDone ? 'bg-green-600' : 'bg-amber-500'}`}>
              {isDone
                ? <Check size={11} strokeWidth={3} className="text-white" />
                : <span className="text-white text-[10px] font-bold leading-none">◐</span>
              }
            </span>
            <span className={`text-sm font-semibold flex-1 line-through truncate cursor-pointer ${isDone ? 'text-green-900' : 'text-amber-900'}`} onClick={onClick}>
              {item.name}
            </span>
            <span className={`text-xs font-semibold shrink-0 ${isDone ? 'text-green-700' : 'text-amber-700'}`}>
              {isDone ? 'Done' : 'Partial'}
              {item.todayLog?.actualPrepQty != null && (
                <span className="font-normal ml-1">— {item.todayLog.actualPrepQty} {item.unit}</span>
              )}
            </span>
          </div>
          <div className="pl-7 mt-1 flex items-center gap-2">
            <span className={`text-xs ${isDone ? 'text-green-600' : 'text-amber-600'}`}>
              {isDone ? 'Completed this session' : 'Partially completed'}
            </span>
            <button
              onClick={() => onStatusChange(item.id, 'NOT_STARTED')}
              className={`text-xs border px-2.5 py-0.5 rounded-lg transition-colors flex items-center gap-1 ${
                isDone
                  ? 'text-green-600 border-green-200 hover:bg-green-100'
                  : 'text-amber-600 border-amber-200 hover:bg-amber-100'
              }`}
            >
              <RotateCcw size={10} /> Reset
            </button>
          </div>
        </div>
        {showRecipe && item.linkedRecipeId && (
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
        )}
      </>
    )
  }

  // ── Blocked row ──────────────────────────────────────────────────────────
  if (isBlocked) {
    return (
      <div className="border-l-[4px] border-l-red-500 bg-red-50/30 border-b border-gray-50 px-3 py-2.5">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 shrink-0">Blocked</span>
          <span className="text-sm font-semibold text-gray-800 flex-1 truncate cursor-pointer" onClick={onClick}>{item.name}</span>
        </div>
        {item.blockedReason && <p className="text-xs text-red-600 mb-2">{item.blockedReason}</p>}
        <button
          onClick={() => onStatusChange(item.id, 'IN_PROGRESS')}
          className="text-xs font-medium bg-gold/10 text-gold border border-gold/30 hover:bg-gold/15 px-3 py-1.5 rounded-lg flex items-center gap-1 transition-colors"
        >
          <Play size={10} fill="currentColor" /> Resume
        </button>
      </div>
    )
  }

  // ── Active row (NOT_STARTED / IN_PROGRESS) ──────────────────────────────
  const suggestColor  = PRIORITY_SUGGEST_COLOR[item.priority] ?? 'text-gray-500'
  const barColor      = PRIORITY_BAR_COLOR[item.priority] ?? 'bg-gray-300'
  const badgeClass    = PRIORITY_BADGE[item.priority] ?? 'bg-gray-100 text-gray-600'
  const priorityLabel = item.manualPriorityOverride
    ? PRIORITY_LABEL[item.priority] ?? item.priority
    : PRIORITY_LABEL[item.priority] ?? item.priority

  const suggestionText = item.priority !== 'LATER'
    ? item.suggestedQty > 0
      ? `Make ${fmtQty(item.suggestedQty)} ${item.unit}${item.priority === '911' ? ' — stock depleted' : ' — below par'}`
      : 'Review stock levels'
    : 'At or above par — looking good'

  return (
    <>
      <div className={`${frame.border} ${frame.bg} border-b border-gray-50 px-3 py-2.5`}>
        {/* Header: priority badge + name + status indicator */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${badgeClass}`}>
            {priorityLabel}
          </span>
          <button onClick={onClick} className="flex-1 min-w-0 text-left hover:opacity-80 transition-opacity">
            <span className="text-sm font-semibold text-gray-800 truncate block">
              {item.name}
              {item.manualPriorityOverride && (
                <span className="ml-1.5 text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full font-medium not-italic">✎</span>
              )}
            </span>
          </button>

          {/* Status chip */}
          {isInProgress ? (
            <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse inline-block" />
              In Progress
            </span>
          ) : (
            <span className="text-[10px] text-gray-400 shrink-0">Not started</span>
          )}

          {/* Recipe icon */}
          {item.linkedRecipeId && (
            <button
              onClick={e => { e.stopPropagation(); setShowRecipe(true) }}
              className="shrink-0 p-1 text-gray-400 hover:text-gold hover:bg-gold/10 rounded-lg transition-colors"
              title="View recipe"
            >
              <BookOpen size={13} />
            </button>
          )}
        </div>

        {/* Stock bar + qty */}
        {item.parLevel > 0 && (
          <div className="flex items-center gap-2 mb-1">
            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${stockPct}%` }} />
            </div>
            <span className="text-[11px] text-gray-500 shrink-0 font-medium tabular-nums">
              {fmtQty(item.onHand)} / {fmtQty(item.parLevel)} {item.unit}
            </span>
          </div>
        )}

        {/* Suggestion text */}
        {item.manualPriorityOverride ? (
          <p className={`text-xs mb-2 line-through text-gray-400`}>
            {item.suggestedQty > 0 ? `System → Make ${fmtQty(item.suggestedQty)} ${item.unit}` : 'System → review stock'}
          </p>
        ) : (
          <p className={`text-xs font-medium mb-2 ${item.priority !== 'LATER' ? suggestColor : 'text-green-600'}`}>
            {suggestionText}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
          {currentStatus === 'NOT_STARTED' && (
            <>
              <button
                onClick={() => onStatusChange(item.id, 'IN_PROGRESS')}
                className="btn-action flex-1 py-1.5 rounded-lg text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors flex items-center justify-center gap-1"
              >
                <Play size={10} fill="currentColor" /> Start
              </button>
              <button
                onClick={() => openDonePrompt('DONE')}
                className="btn-action flex-1 py-1.5 rounded-lg text-xs font-semibold bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors flex items-center justify-center gap-1"
              >
                <Check size={10} strokeWidth={3} /> Done
              </button>
              <button
                onClick={() => onStatusChange(item.id, 'SKIPPED')}
                className="btn-action px-3 py-1.5 rounded-lg text-xs text-gray-400 border border-gray-200 hover:bg-gray-50 transition-colors"
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
                className="btn-action flex-1 py-1.5 rounded-lg text-xs font-semibold bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors flex items-center justify-center gap-1"
              >
                <Check size={10} strokeWidth={3} /> Done
              </button>
              <button
                onClick={() => openDonePrompt('PARTIAL')}
                className="btn-action flex-1 py-1.5 rounded-lg text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors"
              >
                ◐ Partial
              </button>
              <button
                onClick={() => onStatusChange(item.id, 'SKIPPED')}
                className="btn-action px-3 py-1.5 rounded-lg text-xs text-gray-400 border border-gray-200 hover:bg-gray-50 transition-colors"
                title="Remove from today's list"
              >
                Skip
              </button>
            </>
          )}
        </div>
      </div>

      {showRecipe && item.linkedRecipeId && (
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
      )}
    </>
  )
}
