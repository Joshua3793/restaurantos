'use client'
import { useState, useRef, useEffect } from 'react'
import { ChevronRight, AlertCircle, MoreHorizontal, X } from 'lucide-react'
import {
  PREP_PRIORITY_META,
  PREP_STATUS_META,
  PREP_PRIORITY_ORDER,
  type PrepPriority,
} from '@/lib/prep-utils'
import type { PrepItemRich } from './types'

interface Props {
  item: PrepItemRich
  onClick: () => void
  onStatusChange: (itemId: string, status: string, actualQty?: number) => void
  onPriorityChange: (itemId: string, priority: string) => void
}

const STATUS_CYCLE: Record<string, string> = {
  NOT_STARTED: 'IN_PROGRESS',
  IN_PROGRESS: 'DONE',
  DONE:        'NOT_STARTED',
  PARTIAL:     'DONE',
  BLOCKED:     'IN_PROGRESS',
  SKIPPED:     'NOT_STARTED',
}

const INLINE_QTY_STATUSES = new Set(['DONE', 'PARTIAL'])

export function PrepItemRow({ item, onClick, onStatusChange, onPriorityChange }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmingDone, setConfirmingDone] = useState(false)
  const [confirmQty, setConfirmQty] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const priority      = PREP_PRIORITY_META[item.priority]
  const currentStatus = item.todayLog?.status ?? 'NOT_STARTED'
  const statusMeta    = PREP_STATUS_META[currentStatus] ?? PREP_STATUS_META.NOT_STARTED
  const nextStatus    = STATUS_CYCLE[currentStatus] ?? 'IN_PROGRESS'

  // Focus input when inline form opens
  useEffect(() => {
    if (confirmingDone && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [confirmingDone])

  function handleStatusButtonClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (INLINE_QTY_STATUSES.has(nextStatus)) {
      setConfirmQty(item.suggestedQty > 0 ? item.suggestedQty.toFixed(1) : '')
      setConfirmingDone(true)
    } else {
      onStatusChange(item.id, nextStatus)
    }
  }

  function handleConfirm(status: 'DONE' | 'PARTIAL') {
    const parsed = parseFloat(confirmQty)
    const qty = !isNaN(parsed) ? Math.max(0, parsed) : undefined
    onStatusChange(item.id, status, qty)
    setConfirmingDone(false)
  }

  function handleCancel() {
    setConfirmingDone(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') handleCancel()
    if (e.key === 'Enter') handleConfirm('DONE')
  }

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-50 hover:bg-gray-50 transition-colors relative ${priority.borderClass}`}
    >
      {/* Status button */}
      <button
        onClick={handleStatusButtonClick}
        className={`shrink-0 px-2 py-1 rounded-full text-xs font-medium ${statusMeta.badgeClass} hover:opacity-80 transition-opacity`}
      >
        {statusMeta.label}
      </button>

      {/* Name + notes — clickable to open detail panel */}
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onClick}>
        <div className="text-sm font-medium text-gray-800 truncate">{item.name}</div>
        {item.notes && (
          <div className="text-xs text-amber-700 truncate">{item.notes}</div>
        )}
      </div>

      {/* Inline qty confirm form OR make qty chip */}
      {confirmingDone ? (
        <div
          className="flex items-center gap-1.5 shrink-0"
          onClick={e => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            type="number"
            min="0"
            step="0.1"
            value={confirmQty}
            onChange={e => setConfirmQty(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-8 w-20 rounded border border-gray-300 px-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder={item.unit}
          />
          <button
            onClick={() => handleConfirm('DONE')}
            className="h-8 px-2.5 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700 transition-colors"
          >
            Done
          </button>
          <button
            onClick={() => handleConfirm('PARTIAL')}
            className="h-8 px-2.5 rounded bg-amber-500 text-white text-xs font-medium hover:bg-amber-600 transition-colors"
          >
            Partial
          </button>
          <button
            onClick={handleCancel}
            className="h-8 px-2 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <>
          {/* Make qty chip */}
          {item.suggestedQty > 0 && (
            <span className="shrink-0 text-sm font-semibold text-blue-600">
              {item.suggestedQty.toFixed(1)} {item.unit}
            </span>
          )}
          {/* Blocked indicator */}
          {item.isBlocked && (
            <span title={item.blockedReason ?? 'Blocked'} className="shrink-0 text-red-500">
              <AlertCircle size={14} />
            </span>
          )}
        </>
      )}

      {/* Detail arrow */}
      <button onClick={onClick} className="shrink-0 text-gray-400 hover:text-gray-600">
        <ChevronRight size={16} />
      </button>

      {/* More menu */}
      <div className="relative shrink-0">
        <button
          onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
          className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
        >
          <MoreHorizontal size={16} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-7 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-44 text-sm">
              {['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'PARTIAL', 'BLOCKED', 'SKIPPED'].map(s => (
                <button
                  key={s}
                  onClick={() => {
                    setMenuOpen(false)
                    if (INLINE_QTY_STATUSES.has(s)) {
                      // Route DONE/PARTIAL through inline form to capture qty
                      setConfirmQty(item.suggestedQty > 0 ? item.suggestedQty.toFixed(1) : '')
                      setConfirmingDone(true)
                    } else {
                      onStatusChange(item.id, s)
                    }
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
                >
                  {PREP_STATUS_META[s]?.label ?? s}
                </button>
              ))}
              <div className="border-t border-gray-100 my-1" />
              <div className="px-3 py-1 text-xs text-gray-400 font-semibold uppercase">Set Priority</div>
              {PREP_PRIORITY_ORDER.map(p => (
                <button
                  key={p}
                  onClick={() => { onPriorityChange(item.id, p); setMenuOpen(false) }}
                  className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
                >
                  {PREP_PRIORITY_META[p as PrepPriority].label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
