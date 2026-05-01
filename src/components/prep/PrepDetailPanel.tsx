'use client'
import { useState, useEffect } from 'react'
import { X, BookOpen, CheckCircle, Clock, AlertCircle, RotateCcw, ChevronRight, History } from 'lucide-react'
import { CategoryBadge } from '@/components/CategoryBadge'
import {
  PREP_PRIORITY_META,
  PREP_STATUS_META,
  PREP_PRIORITY_ORDER,
  type PrepPriority,
} from '@/lib/prep-utils'
import type { PrepItemRich, PrepItemDetail } from './types'

interface Props {
  item: PrepItemRich
  onClose: () => void
  onRefresh: () => void
  onEdit: () => void
}

interface HistoryLog {
  id: string
  logDate: string
  status: string
  actualPrepQty: string | number | null
  note: string | null
  assignedTo: string | null
}

const STATUS_SHORT: Record<string, { label: string; cls: string }> = {
  DONE:        { label: 'Done',       cls: 'bg-green-100 text-green-700' },
  PARTIAL:     { label: 'Partial',    cls: 'bg-amber-100 text-amber-700' },
  IN_PROGRESS: { label: 'In Progress',cls: 'bg-gold/15 text-gold' },
  BLOCKED:     { label: 'Blocked',    cls: 'bg-red-100 text-red-700' },
  SKIPPED:     { label: 'Skipped',    cls: 'bg-gray-100 text-gray-500' },
  NOT_STARTED: { label: 'Not Started',cls: 'bg-gray-100 text-gray-400' },
}

function fmtDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function PrepDetailPanel({ item, onClose, onRefresh, onEdit }: Props) {
  const [detail, setDetail]             = useState<PrepItemDetail | null>(null)
  const [actualQty, setActualQty]       = useState('')
  const [newRevertQty, setNewRevertQty] = useState('')
  const [showRevert, setShowRevert]     = useState(false)
  const [loading, setLoading]           = useState(false)
  const [warning, setWarning]           = useState<string | null>(null)
  const [history, setHistory]           = useState<HistoryLog[]>([])
  const [showHistory, setShowHistory]   = useState(false)

  useEffect(() => {
    fetch(`/api/prep/items/${item.id}`)
      .then(r => r.json())
      .then(setDetail)
  }, [item.id])

  useEffect(() => {
    fetch(`/api/prep/logs?prepItemId=${item.id}&days=14`)
      .then(r => r.json())
      .then((logs: HistoryLog[]) => setHistory(logs.filter(l => l.status !== 'NOT_STARTED')))
  }, [item.id])

  // Pre-fill actualQty from existing log
  useEffect(() => {
    if (item.todayLog?.actualPrepQty) setActualQty(String(item.todayLog.actualPrepQty))
  }, [item.todayLog?.actualPrepQty])

  const priority   = PREP_PRIORITY_META[item.priority]
  const logStatus  = item.todayLog?.status ?? 'NOT_STARTED'
  const statusMeta = PREP_STATUS_META[logStatus]

  async function ensureLog(): Promise<string> {
    if (item.todayLog?.id) return item.todayLog.id
    const log = await fetch('/api/prep/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prepItemId: item.id }),
    }).then(r => r.json())
    return log.id
  }

  async function updateStatus(newStatus: string) {
    const NEEDS_QTY = new Set(['DONE', 'PARTIAL'])
    if (NEEDS_QTY.has(newStatus) && !actualQty) {
      setWarning('Enter actual prep quantity first')
      return
    }
    setLoading(true)
    setWarning(null)
    const logId = await ensureLog()
    const res = await fetch(`/api/prep/logs/${logId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: newStatus,
        ...(actualQty && { actualPrepQty: parseFloat(actualQty) }),
      }),
    }).then(r => r.json())
    if (res.inventoryResult?.warning) setWarning(res.inventoryResult.warning)
    setLoading(false)
    onRefresh()
  }

  async function handleRevert() {
    if (!newRevertQty) return
    setLoading(true)
    await fetch(`/api/prep/logs/${item.todayLog!.id}/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newActualPrepQty: parseFloat(newRevertQty) }),
    })
    setShowRevert(false)
    setLoading(false)
    onRefresh()
  }

  async function setPriorityOverride(p: string) {
    await fetch(`/api/prep/items/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualPriorityOverride: p || null }),
    })
    onRefresh()
  }

  const baseYield = item.linkedRecipe?.baseYieldQty ?? 0
  const yieldUnit = item.linkedRecipe?.yieldUnit ?? item.unit
  const scale = item.unit === 'batch'
    ? parseFloat(actualQty || '0')
    : yieldUnit === item.unit && baseYield > 0
      ? parseFloat(actualQty || '0') / baseYield
      : 1

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white shadow-xl h-full overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-100 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-semibold text-gray-900 text-base truncate">{item.name}</h2>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${priority.badgeClass}`}>
                {priority.label}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <CategoryBadge category={item.category} />
              {item.station && <span className="text-xs text-gray-400">{item.station}</span>}
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 p-1.5 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 p-4 space-y-5">
          {/* Stock strip */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'On Hand',   value: `${item.onHand.toFixed(1)} ${item.unit}`,     color: item.onHand <= 0 ? 'text-red-600' : 'text-gray-900' },
              { label: 'Par Level', value: `${item.parLevel.toFixed(1)} ${item.unit}`,   color: 'text-gray-900' },
              { label: 'Make',      value: `${item.suggestedQty.toFixed(1)} ${item.unit}`, color: item.suggestedQty > 0 ? 'text-gold font-bold' : 'text-gray-400' },
            ].map(c => (
              <div key={c.label} className="bg-gray-50 rounded-xl p-3 text-center">
                <div className="text-xs text-gray-400 mb-1">{c.label}</div>
                <div className={`text-base font-semibold ${c.color}`}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Status + actions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${statusMeta.badgeClass}`}>{statusMeta.label}</span>
            </div>

            {/* Actual qty input */}
            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Actual Qty Made <span className="text-gray-400">({item.unit}) — required to complete</span>
              </label>
              <input
                type="number" min="0" step="0.1"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                placeholder={`e.g. ${item.suggestedQty.toFixed(1)}`}
                value={actualQty}
                onChange={e => setActualQty(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => updateStatus('IN_PROGRESS')} disabled={loading}
                className="flex items-center justify-center gap-1.5 px-3 py-2 text-sm border border-gold/30 text-gold bg-gold/10 rounded-lg hover:bg-gold/15 disabled:opacity-50">
                <Clock size={14} /> Start
              </button>
              <button onClick={() => updateStatus('DONE')} disabled={loading}
                className="flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50">
                <CheckCircle size={14} /> Mark Done
              </button>
              <button onClick={() => updateStatus('PARTIAL')} disabled={loading}
                className="px-3 py-2 text-sm border border-amber-200 text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 disabled:opacity-50">
                Partial
              </button>
              <button onClick={() => updateStatus('BLOCKED')} disabled={loading}
                className="px-3 py-2 text-sm border border-red-200 text-red-700 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50">
                Blocked
              </button>
            </div>

            {warning && (
              <div className="mt-2 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                <AlertCircle size={13} className="shrink-0 mt-0.5" /> {warning}
              </div>
            )}

            {item.todayLog?.inventoryAdjusted && (
              <div className="mt-2 flex items-center justify-between text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg p-2">
                <span className="flex items-center gap-1"><CheckCircle size={12} /> Inventory Updated</span>
                <button onClick={() => setShowRevert(v => !v)} className="underline hover:no-underline">
                  Correct qty
                </button>
              </div>
            )}

            {showRevert && (
              <div className="mt-2 p-3 bg-gray-50 rounded-lg space-y-2">
                <p className="text-xs text-gray-600">Previous qty: <strong>{item.todayLog?.actualPrepQty} {item.unit}</strong>. Enter corrected qty:</p>
                <input type="number" min="0" step="0.1" value={newRevertQty}
                  onChange={e => setNewRevertQty(e.target.value)}
                  className="w-full border border-gray-200 rounded px-2 py-1 text-sm" />
                <button onClick={handleRevert} disabled={loading || !newRevertQty}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm bg-gray-700 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
                  <RotateCcw size={13} /> Revert &amp; Reapply
                </button>
              </div>
            )}
          </div>

          {/* Inventory impact preview */}
          {item.linkedRecipe && actualQty && parseFloat(actualQty) > 0 && (
            <div className="bg-gold/10 border border-gold/30 rounded-xl p-3 text-xs space-y-1">
              <div className="font-semibold text-gold mb-1">Inventory impact when completed:</div>
              {(detail?.ingredients ?? []).filter(i => i.inventoryItemId).map(ing => (
                <div key={ing.id} className="flex justify-between text-gold">
                  <span>− {(ing.qtyBase * scale).toFixed(2)} {ing.unit} {ing.itemName}</span>
                  <span className={ing.isAvailable === false ? 'text-red-500 font-medium' : ''}>
                    {ing.isAvailable === false ? '⚠ low stock' : ''}
                  </span>
                </div>
              ))}
              {item.linkedRecipe.baseYieldQty && (
                <div className="flex justify-between text-green-700 font-medium border-t border-gold/30 pt-1 mt-1">
                  <span>+ {(baseYield * scale).toFixed(2)} {yieldUnit} {item.linkedRecipe.name}</span>
                </div>
              )}
            </div>
          )}

          {/* Ingredient availability */}
          {detail?.ingredients && detail.ingredients.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Ingredients</div>
              <div className="space-y-1">
                {detail.ingredients.map(ing => (
                  <div key={ing.id} className="flex items-center justify-between text-sm py-1 border-b border-gray-50">
                    <span className="text-gray-700">{ing.itemName}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 text-xs">{ing.qtyBase.toFixed(2)} {ing.unit}</span>
                      {ing.isAvailable === true  && <span className="text-green-500 text-xs">✓</span>}
                      {ing.isAvailable === false && <span className="text-red-500 text-xs font-medium">✗ out</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Linked recipe */}
          {item.linkedRecipe && (
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
              <div className="flex items-center gap-2 text-sm">
                <BookOpen size={14} className="text-gray-400" />
                <span className="text-gray-700">{item.linkedRecipe.name}</span>
              </div>
              <a href={`/recipes?item=${item.linkedRecipe.id}`} className="text-xs text-gold hover:underline flex items-center gap-0.5">
                Open Recipe <ChevronRight size={12} />
              </a>
            </div>
          )}

          {/* 14-day history */}
          <div>
            <button
              onClick={() => setShowHistory(v => !v)}
              className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide w-full"
            >
              <History size={13} />
              Recent History
              <span className="ml-auto text-gray-400">{history.length} entries · {showHistory ? '▲' : '▼'}</span>
            </button>

            {showHistory && (
              <div className="mt-2 rounded-xl border border-gray-100 overflow-hidden">
                {history.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-4">No activity in the last 14 days</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 text-gray-400">
                        <th className="text-left px-3 py-2 font-medium">Date</th>
                        <th className="text-left px-3 py-2 font-medium">Status</th>
                        <th className="text-right px-3 py-2 font-medium">Qty Made</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map(log => {
                        const meta = STATUS_SHORT[log.status] ?? STATUS_SHORT.NOT_STARTED
                        return (
                          <tr key={log.id} className="border-t border-gray-50">
                            <td className="px-3 py-2 text-gray-600">{fmtDate(log.logDate)}</td>
                            <td className="px-3 py-2">
                              <span className={`px-1.5 py-0.5 rounded-full ${meta.cls}`}>{meta.label}</span>
                            </td>
                            <td className="px-3 py-2 text-right text-gray-600">
                              {log.actualPrepQty != null ? `${Number(log.actualPrepQty).toFixed(1)} ${item.unit}` : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          {/* Priority override */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Priority Override</div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setPriorityOverride('')}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${!item.manualPriorityOverride ? 'bg-gray-800 text-white border-gray-800' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
              >
                Auto
              </button>
              {PREP_PRIORITY_ORDER.map(p => (
                <button
                  key={p}
                  onClick={() => setPriorityOverride(p)}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${item.manualPriorityOverride === p ? PREP_PRIORITY_META[p as PrepPriority].badgeClass + ' border-current' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                >
                  {PREP_PRIORITY_META[p as PrepPriority].label}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          {item.notes && (
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-sm text-amber-800">
              {item.notes}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-100">
          <button onClick={onEdit}
            className="w-full px-4 py-2 text-sm border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50">
            Edit Prep Settings
          </button>
        </div>
      </div>
    </div>
  )
}
