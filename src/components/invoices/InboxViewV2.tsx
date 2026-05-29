'use client'
import { useEffect, useState, useCallback } from 'react'
import { formatCurrency } from '@/lib/utils'
import {
  FileText, ChefHat, ArrowRight, TrendingUp, TrendingDown,
  Upload, Clock, CheckCircle2, AlertTriangle, X, Loader2,
} from 'lucide-react'
import { SessionSummary, SessionStatus } from './types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PriceAlert {
  id: string
  direction: string
  changePct: number
  previousPrice: number
  newPrice: number
  acknowledged: boolean
  inventoryItem: { id: string; itemName: string }
  session: { id: string; supplierName: string | null; invoiceDate: string | null }
}

interface RecipeAlert {
  id: string
  changePct: number
  newFoodCostPct: number | null
  exceededThreshold: boolean
  acknowledged: boolean
  recipe: { id: string; name: string; menuPrice: number | null }
  session: { id: string; supplierName: string | null }
}

interface Props {
  sessions: SessionSummary[]
  onSelectSession: (id: string) => void
  onUploadClick: () => void
  onScanClick?: () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Partial<Record<SessionStatus, string>> = {
  REVIEW:     'Needs review',
  PROCESSING: 'Processing',
  UPLOADING:  'Uploading',
  APPROVING:  'Applying',
  ERROR:      'Error',
}

const STATUS_TINT: Partial<Record<SessionStatus, { bg: string; text: string; dot: string }>> = {
  REVIEW:     { bg: 'bg-gold-soft',  text: 'text-gold-2',    dot: 'bg-gold' },
  PROCESSING: { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  UPLOADING:  { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  APPROVING:  { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  ERROR:      { bg: 'bg-red-soft',   text: 'text-red-text',  dot: 'bg-red' },
}

function fmtDate(d: string | null) {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtAge(createdAt: string) {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000)
  if (mins < 1)    return 'just now'
  if (mins < 60)   return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHead({ label, count, action }: { label: string; count: number; action?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-2 px-1">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 flex items-baseline gap-2">
        {label}
        {count > 0 && <span className="font-mono text-[10.5px] text-ink-2 normal-case tracking-normal">· {count}</span>}
      </h3>
      {action}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function InboxViewV2({ sessions, onSelectSession, onUploadClick, onScanClick }: Props) {
  const [priceAlerts, setPriceAlerts]   = useState<PriceAlert[]>([])
  const [recipeAlerts, setRecipeAlerts] = useState<RecipeAlert[]>([])
  const [dismissing, setDismissing]     = useState<Set<string>>(new Set())

  const fetchAlerts = useCallback(async () => {
    try {
      const data = await fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      if (data) {
        setPriceAlerts(data.priceAlerts ?? [])
        setRecipeAlerts(data.recipeAlerts ?? [])
      }
    } catch {}
  }, [])

  useEffect(() => {
    fetchAlerts()
    const t = setInterval(fetchAlerts, 30_000)
    return () => clearInterval(t)
  }, [fetchAlerts])

  // Queue: non-approved, non-rejected sessions, sorted by urgency
  const queue = sessions
    .filter(s => !['APPROVED', 'REJECTED'].includes(s.status))
    .sort((a, b) => {
      const order: Partial<Record<SessionStatus, number>> = { REVIEW: 0, ERROR: 1, APPROVING: 2, PROCESSING: 3, UPLOADING: 4 }
      return (order[a.status] ?? 9) - (order[b.status] ?? 9)
    })

  // Recent approved — last 5
  const recent = sessions.filter(s => s.status === 'APPROVED').slice(0, 5)

  const alertCount = priceAlerts.length + recipeAlerts.length

  async function dismissPriceAlert(id: string) {
    setDismissing(prev => new Set([...prev, id]))
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceAlertIds: [id] }),
      })
      setPriceAlerts(prev => prev.filter(a => a.id !== id))
    } finally {
      setDismissing(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  async function dismissRecipeAlert(id: string) {
    setDismissing(prev => new Set([...prev, id]))
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeAlertIds: [id] }),
      })
      setRecipeAlerts(prev => prev.filter(a => a.id !== id))
    } finally {
      setDismissing(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  async function dismissAll() {
    await fetch('/api/invoices/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acknowledgeAll: true }),
    })
    setPriceAlerts([])
    setRecipeAlerts([])
  }

  return (
    <div className="space-y-6">
      {/* ── Queue ────────────────────────────────────────────────────────── */}
      <section>
        <SectionHead
          label="Queue"
          count={queue.length}
          action={
            <div className="flex items-center gap-2">
              {onScanClick && (
                <button
                  onClick={onScanClick}
                  className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:border-ink-3 transition-colors"
                >
                  <FileText size={12} className="text-ink-3" /> Scan
                </button>
              )}
              <button
                onClick={onUploadClick}
                className="inline-flex items-center gap-1.5 bg-ink text-paper px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:bg-[#18181b] transition-colors"
              >
                <Upload size={12} className="text-gold" /> Upload
              </button>
            </div>
          }
        />
        {queue.length === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] px-6 py-10 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
            <p className="text-[13px] text-ink-3 mt-1.5">No pending invoices — your inbox is empty.</p>
          </div>
        ) : (
          <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
            {queue.map((session, idx) => {
              const isActive = session.status === 'PROCESSING' || session.status === 'UPLOADING' || session.status === 'APPROVING'
              const isError  = session.status === 'ERROR'
              const canOpen  = session.status === 'REVIEW' || session.status === 'ERROR'
              const tint = STATUS_TINT[session.status] ?? { bg: 'bg-bg-2', text: 'text-ink-3', dot: 'bg-ink-4' }
              const isLast = idx === queue.length - 1

              return (
                <div
                  key={session.id}
                  onClick={() => canOpen && onSelectSession(session.id)}
                  className={`group grid grid-cols-[40px_1fr_auto_auto] gap-3.5 items-center px-[18px] py-3.5 transition-colors ${
                    isLast ? '' : 'border-b border-line'
                  } ${canOpen ? 'cursor-pointer hover:bg-bg-2/40' : 'cursor-default'} ${isError ? 'bg-red-soft/30' : ''}`}
                >
                  {/* Status icon */}
                  <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${tint.bg}`}>
                    {isActive
                      ? <Loader2 size={15} className={`${tint.text} animate-spin`} />
                      : isError
                        ? <AlertTriangle size={15} className={tint.text} />
                        : <FileText size={15} className={tint.text} />
                    }
                  </div>

                  {/* Content */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-medium text-ink tracking-[-0.01em] truncate">
                        {session.supplierName ?? 'Unknown supplier'}
                      </span>
                      <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.04em] font-medium px-2 py-0.5 rounded-full ${tint.bg} ${tint.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${tint.dot}`} />
                        {STATUS_LABEL[session.status] ?? session.status}
                      </span>
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0]">
                      {session.invoiceNumber && <><span className="text-ink-2">#{session.invoiceNumber}</span> · </>}
                      {session.invoiceDate && <>{fmtDate(session.invoiceDate)} · </>}
                      <b className="text-ink-2 font-medium">{session._count.scanItems}</b> {session._count.scanItems === 1 ? 'line' : 'lines'}
                      {(session._count.priceAlerts > 0 || session._count.recipeAlerts > 0) && (
                        <> · <span className="text-gold-2 font-semibold">{session._count.priceAlerts + session._count.recipeAlerts} alert{session._count.priceAlerts + session._count.recipeAlerts === 1 ? '' : 's'}</span></>
                      )}
                      <> · <span className="text-ink-4">{fmtAge(session.createdAt)}</span></>
                    </div>
                  </div>

                  {/* Total */}
                  {session.total && (
                    <div className="font-mono text-[13.5px] font-semibold text-ink tabular-nums tracking-[-0.01em] text-right whitespace-nowrap">
                      {formatCurrency(parseFloat(String(session.total)))}
                    </div>
                  )}

                  {/* CTA */}
                  {canOpen ? (
                    <button className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-ink text-paper font-medium hover:bg-[#27272a] transition-colors whitespace-nowrap">
                      {isError ? 'Retry' : 'Review'}
                    </button>
                  ) : (
                    <span className="w-7" />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Price & recipe alerts ───────────────────────────────────────── */}
      <section>
        <SectionHead
          label="Active alerts"
          count={alertCount}
          action={alertCount > 0 ? (
            <button
              onClick={dismissAll}
              className="font-mono text-[10.5px] text-ink-3 hover:text-ink-2 transition-colors uppercase tracking-[0.04em]"
            >
              Dismiss all
            </button>
          ) : null}
        />
        {alertCount === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] px-6 py-8 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">Costs stable</p>
            <p className="text-[13px] text-ink-3 mt-1.5">No price or recipe alerts.</p>
          </div>
        ) : (
          <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
            {priceAlerts.map((alert, idx) => {
              const up = alert.direction === 'UP'
              const isLast = idx === priceAlerts.length - 1 && recipeAlerts.length === 0
              return (
                <div key={alert.id}
                  className={`grid grid-cols-[40px_1fr_auto_auto] gap-3.5 items-center px-[18px] py-3 ${isLast ? '' : 'border-b border-line'}`}>
                  <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${up ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'}`}>
                    {up ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">{alert.inventoryItem.itemName}</div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5 tracking-[0]">
                      {formatCurrency(Number(alert.previousPrice))} <span className="text-ink-4">→</span> <span className="text-ink-2">{formatCurrency(Number(alert.newPrice))}</span>
                      {alert.session.supplierName && <> · {alert.session.supplierName}</>}
                    </div>
                  </div>
                  <div className={`font-mono text-[13px] font-semibold tabular-nums whitespace-nowrap ${up ? 'text-red-text' : 'text-green-text'}`}>
                    {up ? '+' : ''}{Number(alert.changePct).toFixed(1)}%
                  </div>
                  <button
                    onClick={() => dismissPriceAlert(alert.id)}
                    disabled={dismissing.has(alert.id)}
                    title="Dismiss"
                    className="w-7 h-7 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-40 transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>
              )
            })}

            {recipeAlerts.map((alert, idx) => {
              const isLast = idx === recipeAlerts.length - 1
              const sev    = alert.exceededThreshold
              return (
                <div key={alert.id}
                  className={`grid grid-cols-[40px_1fr_auto_auto] gap-3.5 items-center px-[18px] py-3 ${isLast ? '' : 'border-b border-line'}`}>
                  <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${sev ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'}`}>
                    <ChefHat size={15} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">{alert.recipe.name}</div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5 tracking-[0]">
                      {sev && alert.newFoodCostPct !== null && (
                        <span className="text-red-text font-semibold">FC {(Number(alert.newFoodCostPct) * 100).toFixed(1)}% over target · </span>
                      )}
                      Cost {Number(alert.changePct) > 0 ? '+' : ''}{Number(alert.changePct).toFixed(1)}%
                      {alert.session.supplierName && <> · {alert.session.supplierName}</>}
                    </div>
                  </div>
                  <span className={`font-mono text-[10.5px] uppercase tracking-[0.04em] font-semibold px-2 py-0.5 rounded-full ${sev ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'}`}>
                    Recipe
                  </span>
                  <button
                    onClick={() => dismissRecipeAlert(alert.id)}
                    disabled={dismissing.has(alert.id)}
                    title="Dismiss"
                    className="w-7 h-7 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-40 transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Recent activity ─────────────────────────────────────────────── */}
      {recent.length > 0 && (
        <section>
          <SectionHead label="Recently approved" count={0} />
          <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
            {recent.map((session, idx) => {
              const isLast = idx === recent.length - 1
              return (
                <button
                  key={session.id}
                  onClick={() => onSelectSession(session.id)}
                  className={`group w-full grid grid-cols-[28px_1fr_auto_auto] gap-3 items-center px-[18px] py-2.5 text-left hover:bg-bg-2/40 transition-colors ${isLast ? '' : 'border-b border-line'}`}
                >
                  <CheckCircle2 size={14} className="text-green-text shrink-0" />
                  <span className="text-[13px] text-ink-2 truncate">
                    {session.supplierName ?? 'Unknown'}
                    {session.invoiceDate ? <span className="font-mono text-[10.5px] text-ink-3"> · {fmtDate(session.invoiceDate)}</span> : ''}
                  </span>
                  {session.total ? (
                    <span className="font-mono text-[12.5px] text-ink tabular-nums shrink-0">
                      {formatCurrency(parseFloat(String(session.total)))}
                    </span>
                  ) : <span />}
                  <span className="font-mono text-[10.5px] text-ink-3 shrink-0 inline-flex items-center gap-1">
                    <Clock size={10} /> {fmtAge(session.createdAt)}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {/* Footer hint */}
      <div className="flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide pt-2">
        <span>QUEUE REFRESHES EVERY 30S · OCR THEN REVIEW THEN APPROVE</span>
        <span>
          <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘U</kbd> UPLOAD
        </span>
      </div>

      <ArrowRight className="hidden" /> {/* preserve import (used elsewhere historically) */}
    </div>
  )
}
