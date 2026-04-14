'use client'
import { useState } from 'react'
import { ChevronRight, AlertCircle, MoreHorizontal, BookOpen } from 'lucide-react'
import { CategoryBadge } from '@/components/CategoryBadge'
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
  onStatusChange: (itemId: string, status: string) => void
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

export function PrepItemRow({ item, onClick, onStatusChange, onPriorityChange }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const priority      = PREP_PRIORITY_META[item.priority]
  const currentStatus = item.todayLog?.status ?? 'NOT_STARTED'
  const statusMeta    = PREP_STATUS_META[currentStatus] ?? PREP_STATUS_META.NOT_STARTED

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-50 hover:bg-gray-50 transition-colors ${priority.borderClass} relative`}
    >
      {/* Status button */}
      <button
        onClick={e => { e.stopPropagation(); onStatusChange(item.id, STATUS_CYCLE[currentStatus] ?? 'IN_PROGRESS') }}
        className={`shrink-0 px-2 py-1 rounded-full text-xs font-medium ${statusMeta.badgeClass} hover:opacity-80 transition-opacity`}
      >
        {statusMeta.label}
      </button>

      {/* Name + badges — clickable */}
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onClick}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-800 truncate">{item.name}</span>
          {item.linkedRecipe && (
            <span className="shrink-0 inline-flex items-center gap-1 text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
              <BookOpen size={10} />
              {item.linkedRecipe.name}
            </span>
          )}
          {item.isBlocked && (
            <span title={item.blockedReason ?? 'Blocked'} className="shrink-0 text-red-500">
              <AlertCircle size={14} />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <CategoryBadge category={item.category} />
          {item.station && (
            <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{item.station}</span>
          )}
        </div>
      </div>

      {/* Stock numbers */}
      <div className="hidden md:flex items-center gap-4 text-xs shrink-0">
        <div className="text-center">
          <div className="font-semibold text-gray-700">{item.onHand.toFixed(1)}</div>
          <div className="text-gray-400">on hand</div>
        </div>
        <div className="text-center">
          <div className="font-semibold text-gray-700">{item.parLevel.toFixed(1)}</div>
          <div className="text-gray-400">par</div>
        </div>
        <div className="text-center">
          <div className={`font-bold ${item.suggestedQty > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
            {item.suggestedQty.toFixed(1)}
          </div>
          <div className="text-gray-400">make</div>
        </div>
        <div className="text-xs text-gray-400">{item.unit}</div>
      </div>

      {/* Priority badge */}
      <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${priority.badgeClass}`}>
        {priority.label}
      </span>

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
                  onClick={() => { onStatusChange(item.id, s); setMenuOpen(false) }}
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
