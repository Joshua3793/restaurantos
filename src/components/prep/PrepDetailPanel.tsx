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
    <div
      className="fixed inset-0 z-[60] flex justify-end"
      onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
      onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true') onClose() }}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" aria-hidden />
      <div
        className="relative w-full max-w-md bg-bg shadow-2xl h-full overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 bg-paper p-5 border-b border-line flex items-start justify-between gap-3"
          style={{ paddingTop: 'calc(1.25rem + env(safe-area-inset-top, 0px))' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-medium text-ink text-[19px] leading-[1.15] tracking-[-0.02em] truncate">{item.name}</h2>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${priority.badgeClass}`}>
                {priority.label}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <CategoryBadge category={item.category} />
              {item.station && <span className="font-mono text-[10.5px] text-ink-4 uppercase tracking-[0.02em]">{item.station}</span>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 w-8 h-8 grid place-items-center rounded-[8px] border border-line text-ink-3 hover:border-ink-4 hover:text-ink-2 transition-colors bg-paper">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 p-5 space-y-5">
          {/* Stock strip */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'ON HAND',   value: `${item.onHand.toFixed(1)} ${item.unit}`,     color: item.onHand <= 0 ? 'text-red-600' : 'text-ink' },
              { label: 'PAR LEVEL', value: `${item.parLevel.toFixed(1)} ${item.unit}`,   color: 'text-ink' },
              { label: 'MAKE',      value: `${item.suggestedQty.toFixed(1)} ${item.unit}`, color: item.suggestedQty > 0 ? 'text-gold-2' : 'text-ink-4' },
            ].map(c => (
              <div key={c.label} className="bg-paper border border-line rounded-[10px] p-3 text-center">
                <div className="font-mono text-[10px] text-ink-3 tracking-[0.02em] mb-1.5">{c.label}</div>
                <div className={`font-mono text-[15px] font-semibold tabular-nums tracking-[-0.01em] ${c.color}`}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Status + actions */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <span className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em]">Status</span>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${statusMeta.badgeClass}`}>{statusMeta.label}</span>
            </div>

            {/* Actual qty input */}
            <div className="mb-3">
              <label className="block text-[12px] font-medium text-ink-2 mb-1.5">
                Actual qty made <span className="text-ink-4 font-normal">({item.unit}) — required to complete</span>
              </label>
              <input
                type="number" min="0" step="0.1"
                className="w-full bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors tracking-[-0.005em]"
                placeholder={`e.g. ${item.suggestedQty.toFixed(1)}`}
                value={actualQty}
                onChange={e => setActualQty(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => updateStatus('IN_PROGRESS')} disabled={loading}
                className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-[13px] font-medium border border-[#fcd34d] text-gold-2 bg-gold-soft rounded-[9px] hover:bg-[#fde9c8] transition-colors disabled:opacity-50">
                <Clock size={14} /> Start
              </button>
              <button onClick={() => updateStatus('DONE')} disabled={loading}
                className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-[13px] font-medium bg-ink text-paper rounded-[9px] hover:bg-ink-2 transition-colors disabled:opacity-50">
                <CheckCircle size={14} className="text-green-400" /> Mark done
              </button>
              <button onClick={() => updateStatus('PARTIAL')} disabled={loading}
                className="px-3 py-2.5 text-[13px] font-medium border border-amber-200 text-amber-700 bg-amber-50 rounded-[9px] hover:bg-amber-100 transition-colors disabled:opacity-50">
                Partial
              </button>
              <button onClick={() => updateStatus('BLOCKED')} disabled={loading}
                className="px-3 py-2.5 text-[13px] font-medium border border-red-200 text-red-700 bg-red-50 rounded-[9px] hover:bg-red-100 transition-colors disabled:opacity-50">
                Blocked
              </button>
            </div>

            {warning && (
              <div className="mt-2 flex items-start gap-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-[9px] p-2.5">
                <AlertCircle size={13} className="shrink-0 mt-0.5" /> {warning}
              </div>
            )}

            {item.todayLog?.inventoryAdjusted && (
              <div className="mt-2 flex items-center justify-between text-[12px] text-green-700 bg-green-50 border border-green-200 rounded-[9px] p-2.5">
                <span className="flex items-center gap-1.5"><CheckCircle size={12} /> Inventory updated</span>
                <button onClick={() => setShowRevert(v => !v)} className="underline hover:no-underline font-medium">
                  Correct qty
                </button>
              </div>
            )}

            {showRevert && (
              <div className="mt-2 p-3 bg-paper border border-line rounded-[10px] space-y-2">
                <p className="text-[12px] text-ink-2">Previous qty: <strong className="text-ink">{item.todayLog?.actualPrepQty} {item.unit}</strong>. Enter corrected qty:</p>
                <input type="number" min="0" step="0.1" value={newRevertQty}
                  onChange={e => setNewRevertQty(e.target.value)}
                  className="w-full bg-paper border border-line rounded-[8px] px-2.5 py-1.5 text-[13px] text-ink focus:outline-none focus:border-ink-3 transition-colors" />
                <button onClick={handleRevert} disabled={loading || !newRevertQty}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[13px] font-medium bg-ink text-paper rounded-[9px] hover:bg-ink-2 transition-colors disabled:opacity-50">
                  <RotateCcw size={13} /> Revert &amp; reapply
                </button>
              </div>
            )}
          </div>

          {/* Inventory impact preview */}
          {item.linkedRecipe && actualQty && parseFloat(actualQty) > 0 && (
            <div className="bg-gold-soft border border-[#fcd34d] rounded-[10px] p-3 text-[12px] space-y-1">
              <div className="font-mono text-[10.5px] font-semibold text-gold-2 uppercase tracking-[0.02em] mb-1.5">Inventory impact when completed</div>
              {(detail?.ingredients ?? []).filter(i => i.inventoryItemId).map(ing => (
                <div key={ing.id} className="flex justify-between text-[#78350f] tabular-nums">
                  <span>− {(ing.qtyBase * scale).toFixed(2)} {ing.unit} {ing.itemName}</span>
                  <span className={ing.isAvailable === false ? 'text-red-600 font-medium' : ''}>
                    {ing.isAvailable === false ? '⚠ low stock' : ''}
                  </span>
                </div>
              ))}
              {item.linkedRecipe.baseYieldQty && (
                <div className="flex justify-between text-green-700 font-medium border-t border-[#fcd34d] pt-1.5 mt-1.5 tabular-nums">
                  <span>+ {(baseYield * scale).toFixed(2)} {yieldUnit} {item.linkedRecipe.name}</span>
                </div>
              )}
            </div>
          )}

          {/* Ingredient availability */}
          {detail?.ingredients && detail.ingredients.length > 0 && (
            <div>
              <div className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em] mb-2">Ingredients</div>
              <div className="space-y-0.5">
                {detail.ingredients.map(ing => (
                  <div key={ing.id} className="flex items-center justify-between text-[13px] py-1.5 border-b border-line last:border-0">
                    <span className="text-ink-2">{ing.itemName}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-ink-3 text-[11px] tabular-nums">{ing.qtyBase.toFixed(2)} {ing.unit}</span>
                      {ing.isAvailable === true  && <span className="text-green-600 text-[12px]">✓</span>}
                      {ing.isAvailable === false && <span className="text-red-600 text-[11px] font-medium">✗ out</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Linked recipe */}
          {item.linkedRecipe && (
            <div className="flex items-center justify-between p-3 bg-paper border border-line rounded-[10px]">
              <div className="flex items-center gap-2 text-[13px]">
                <BookOpen size={14} className="text-ink-3" />
                <span className="text-ink-2">{item.linkedRecipe.name}</span>
              </div>
              <a href={`/recipes?item=${item.linkedRecipe.id}`} className="text-[12px] text-gold-2 hover:underline flex items-center gap-0.5 font-medium">
                Open recipe <ChevronRight size={12} />
              </a>
            </div>
          )}

          {/* 14-day history */}
          <div>
            <button
              onClick={() => setShowHistory(v => !v)}
              className="flex items-center gap-2 font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em] w-full"
            >
              <History size={13} />
              Recent history
              <span className="ml-auto text-ink-4 normal-case tracking-normal">{history.length} entries · {showHistory ? '▲' : '▼'}</span>
            </button>

            {showHistory && (
              <div className="mt-2 rounded-[10px] border border-line overflow-hidden">
                {history.length === 0 ? (
                  <p className="text-[12px] text-ink-4 text-center py-4">No activity in the last 14 days</p>
                ) : (
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-bg-2 text-ink-3 font-mono">
                        <th className="text-left px-3 py-2 font-medium text-[10.5px] tracking-[0.02em]">DATE</th>
                        <th className="text-left px-3 py-2 font-medium text-[10.5px] tracking-[0.02em]">STATUS</th>
                        <th className="text-right px-3 py-2 font-medium text-[10.5px] tracking-[0.02em]">QTY MADE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map(log => {
                        const meta = STATUS_SHORT[log.status] ?? STATUS_SHORT.NOT_STARTED
                        return (
                          <tr key={log.id} className="border-t border-line">
                            <td className="px-3 py-2 text-ink-2">{fmtDate(log.logDate)}</td>
                            <td className="px-3 py-2">
                              <span className={`px-1.5 py-0.5 rounded-full ${meta.cls}`}>{meta.label}</span>
                            </td>
                            <td className="px-3 py-2 text-right text-ink-2 font-mono tabular-nums">
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
            <div className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em] mb-2">Priority override</div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setPriorityOverride('')}
                className={`px-3 py-1 text-[12px] font-medium rounded-full border transition-colors ${!item.manualPriorityOverride ? 'bg-ink text-paper border-ink' : 'border-line text-ink-2 hover:border-ink-3'}`}
              >
                Auto
              </button>
              {PREP_PRIORITY_ORDER.map(p => (
                <button
                  key={p}
                  onClick={() => setPriorityOverride(p)}
                  className={`px-3 py-1 text-[12px] font-medium rounded-full border transition-colors ${item.manualPriorityOverride === p ? PREP_PRIORITY_META[p as PrepPriority].badgeClass + ' border-current' : 'border-line text-ink-2 hover:border-ink-3'}`}
                >
                  {PREP_PRIORITY_META[p as PrepPriority].label}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          {item.notes && (
            <div className="bg-gold-soft border border-[#fcd34d] rounded-[10px] p-3 text-[13px] text-[#78350f]">
              {item.notes}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="sticky bottom-0 bg-paper p-4 border-t border-line"
          style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <button onClick={onEdit}
            className="w-full px-4 py-2.5 text-[13px] font-medium border border-line text-ink-2 rounded-[9px] hover:border-ink-3 transition-colors bg-paper">
            Edit prep settings
          </button>
        </div>
      </div>
    </div>
  )
}
