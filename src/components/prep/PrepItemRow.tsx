'use client'
import { useState, useRef, useEffect } from 'react'
import { ChevronRight, AlertCircle, X, Check, BookOpen, Play, SkipForward, RotateCcw } from 'lucide-react'
import {
  PREP_PRIORITY_META,
} from '@/lib/prep-utils'
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

function getAttentionReason(item: PrepItemRich): string | null {
  if (item.manualPriorityOverride) return null
  const { onHand, parLevel, targetToday, unit } = item
  const fmt = (n: number) => n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)
  if (onHand <= 0 && parLevel > 0) return `Out of stock — par level is ${fmt(parLevel)} ${unit}`
  if (targetToday !== null && onHand < targetToday) return `Below today's target (have ${fmt(onHand)}, need ${fmt(targetToday)} ${unit})`
  if (onHand < parLevel) return `Below par level (have ${fmt(onHand)}, par ${fmt(parLevel)} ${unit})`
  return null
}

// Priority frame: colored left border + subtle bg tint
const PRIORITY_FRAME: Record<string, { border: string; bg: string }> = {
  '911':          { border: 'border-l-[4px] border-l-red-500',    bg: 'bg-red-50/40' },
  'NEEDED_TODAY': { border: 'border-l-[4px] border-l-orange-400', bg: 'bg-orange-50/40' },
  'LATER':        { border: 'border-l-[4px] border-l-gray-200',   bg: '' },
}

function getPriorityFrame(priority: string) {
  return PRIORITY_FRAME[priority] ?? { border: 'border-l-[4px] border-l-transparent', bg: '' }
}

// ─────────────────────────────────────────────────────────────────────────────

export function PrepItemRow({ item, onClick, onStatusChange, onPriorityChange, onDelete, onToggleOnList, showReason = false }: Props) {
  const [confirmingDone, setConfirmingDone]     = useState(false)
  const [confirmQty, setConfirmQty]             = useState('')
  const [pendingStatus, setPendingStatus]       = useState<'DONE' | 'PARTIAL'>('DONE')
  const [showRecipe, setShowRecipe]             = useState(false)
  const [checkedIngredients, setCheckedIngredients] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  const priority      = PREP_PRIORITY_META[item.priority]
  const currentStatus = item.todayLog?.status ?? 'NOT_STARTED'
  const frame         = getPriorityFrame(item.priority)

  // Clear ingredient checkboxes when the item is marked done/partial
  useEffect(() => {
    if (currentStatus === 'DONE' || currentStatus === 'PARTIAL') {
      setCheckedIngredients(new Set())
    }
  }, [currentStatus])

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

  // ── TODAY MODE ──────────────────────────────────────────────────────────────

  // Done quantity prompt — shown as a full-width overlay on the row
  if (confirmingDone) {
    return (
      <div className={`flex items-center gap-2 px-3 py-3 border-b border-gray-50 ${frame.border} ${frame.bg}`}>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-500 mb-1">
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
      </div>
    )
  }

  // Normal today row
  const isDone    = currentStatus === 'DONE'
  const isPartial = currentStatus === 'PARTIAL'
  const isCompleted = isDone || isPartial

  // Completed items get a colored frame regardless of priority
  const rowFrame = isDone    ? { border: 'border-l-[4px] border-l-green-500',  bg: 'bg-green-100/70'  }
                : isPartial  ? { border: 'border-l-[4px] border-l-yellow-500', bg: 'bg-yellow-100/80' }
                : frame

  return (
    <>
      <div className={`flex items-center gap-2 px-3 py-2.5 border-b border-gray-50 transition-colors ${rowFrame.border} ${rowFrame.bg} ${isCompleted ? 'opacity-70' : 'hover:bg-gray-50/50'}`}>

        {/* Left indicator: priority badge for active items, checkmark for completed */}
        {isCompleted ? (
          <span className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${isDone ? 'bg-green-600' : 'bg-yellow-500'}`}>
            {isDone
              ? <Check size={12} strokeWidth={3} className="text-white" />
              : <span className="text-white text-xs font-bold leading-none">◐</span>
            }
          </span>
        ) : (
          <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full border ${priority.badgeClass}`} style={{ borderColor: 'transparent' }}>
            {priority.emoji}
          </span>
        )}

        {/* Name + station badge + status label for completed, suggested qty for active */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onClick}>
          <div className={`text-sm font-medium truncate ${isDone ? 'text-green-900' : isPartial ? 'text-yellow-900' : 'text-gray-800'}`}>
            {item.name}
          </div>
          {item.station?.trim() && (
            <span className="text-[10px] font-medium bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-full mt-0.5 inline-block">
              {item.station.trim()}
            </span>
          )}
          {isCompleted ? (
            <div className={`text-xs font-semibold mt-0.5 ${isDone ? 'text-green-700' : 'text-yellow-700'}`}>
              {isDone ? '✓ Done' : '◐ Partial'}
              {item.todayLog?.actualPrepQty != null && (
                <span className={`font-normal ml-1 ${isDone ? 'text-green-600' : 'text-yellow-600'}`}>
                  — {item.todayLog.actualPrepQty} {item.unit}
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 mt-0.5">
              {item.suggestedQty > 0 && (
                <span className="text-xs font-semibold text-gold">
                  Make {item.suggestedQty.toFixed(1)} {item.unit}
                </span>
              )}
              {item.isBlocked && (
                <span className="text-xs text-red-500 flex items-center gap-0.5">
                  <AlertCircle size={11} /> Blocked
                </span>
              )}
            </div>
          )}
        </div>

        {/* Recipe view button — only for active items */}
        {item.linkedRecipeId && !isCompleted && (
          <button
            onClick={e => { e.stopPropagation(); setShowRecipe(true) }}
            className="shrink-0 p-1.5 text-gray-400 hover:text-gold hover:bg-gold/10 rounded-lg transition-colors"
            title="View recipe"
          >
            <BookOpen size={15} />
          </button>
        )}

        {/* Status action buttons */}
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          {currentStatus === 'NOT_STARTED' && (
            <>
              <button
                onClick={() => onStatusChange(item.id, 'IN_PROGRESS')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gold/10 text-gold border border-gold/30 hover:bg-gold/15 transition-colors"
              >
                <Play size={10} fill="currentColor" /> Start
              </button>
              <button
                onClick={() => openDonePrompt('DONE')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors"
              >
                <Check size={10} strokeWidth={3} /> Done
              </button>
            </>
          )}

          {currentStatus === 'IN_PROGRESS' && (
            <>
              <button
                onClick={() => openDonePrompt('DONE')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors"
              >
                <Check size={10} strokeWidth={3} /> Done
              </button>
              <button
                onClick={() => openDonePrompt('PARTIAL')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors"
              >
                ◐ Partial
              </button>
              <button
                onClick={() => onToggleOnList?.(item.id, false)}
                className="flex items-center gap-1 px-2 py-1 rounded-full text-xs text-gray-400 border border-gray-200 hover:bg-gray-100 transition-colors"
                title="Remove from today's list"
              >
                <SkipForward size={10} />
              </button>
            </>
          )}

          {isCompleted && (
            <button
              onClick={() => onStatusChange(item.id, 'NOT_STARTED')}
              className={`p-1 rounded-full transition-colors ${isDone ? 'text-green-600 hover:text-green-800 hover:bg-green-200' : 'text-yellow-600 hover:text-yellow-800 hover:bg-yellow-200'}`}
              title="Reset"
            >
              <RotateCcw size={12} />
            </button>
          )}

          {currentStatus === 'BLOCKED' && (
            <>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Blocked</span>
              <button
                onClick={() => onStatusChange(item.id, 'IN_PROGRESS')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gold/10 text-gold border border-gold/30 hover:bg-gold/15 transition-colors"
              >
                <Play size={10} fill="currentColor" /> Resume
              </button>
            </>
          )}

          {currentStatus === 'SKIPPED' && (
            <button
              onClick={() => onStatusChange(item.id, 'NOT_STARTED')}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100 transition-colors"
            >
              <RotateCcw size={10} /> Restore
            </button>
          )}
        </div>

        {/* Detail arrow */}
        <button onClick={onClick} className={`shrink-0 ${isDone ? 'text-green-600 hover:text-green-800' : isPartial ? 'text-yellow-600 hover:text-yellow-800' : 'text-gray-300 hover:text-gray-500'}`}>
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Recipe popup */}
      {showRecipe && item.linkedRecipeId && (
        <RecipeViewModal
          recipeId={item.linkedRecipeId}
          recipeName={item.name}
          suggestedQty={item.suggestedQty > 0 ? item.suggestedQty : undefined}
          yieldUnit={item.unit}
          baseYieldQty={item.linkedRecipe?.baseYieldQty}
          checkedIngredients={checkedIngredients}
          onToggleIngredient={id => setCheckedIngredients(prev => {
            const next = new Set(prev)
            next.has(id) ? next.delete(id) : next.add(id)
            return next
          })}
          onClose={() => setShowRecipe(false)}
        />
      )}
    </>
  )
}
