'use client'
import { useEffect, useState, useCallback } from 'react'
import { formatCurrency } from '@/lib/utils'
import {
  FileText, TrendingUp, TrendingDown, ChefHat, ArrowRight,
  Upload, Clock, CheckCircle2, AlertTriangle, X, List,
  Loader2,
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
  onSwitchToHistory: () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Partial<Record<SessionStatus, string>> = {
  REVIEW:     'Needs review',
  PROCESSING: 'Processing…',
  UPLOADING:  'Uploading…',
  APPROVING:  'Applying…',
  ERROR:      'Error',
}

const STATUS_COLOR: Partial<Record<SessionStatus, string>> = {
  REVIEW:     'bg-gold-soft text-gold-2 border-gold-soft',
  PROCESSING: 'bg-gold/10 text-gold border-gold/30',
  UPLOADING:  'bg-gold/10 text-gold border-gold/30',
  APPROVING:  'bg-blue-soft text-blue border-blue-soft',
  ERROR:      'bg-red-soft text-red border-red-soft',
}

function fmtDate(d: string | null) {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
}

function fmtAge(createdAt: string) {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000)
  if (mins < 60)   return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <p className="text-[10px] font-semibold tracking-widest uppercase text-ink-4">{label}</p>
      {count > 0 && (
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-bg-2 text-ink-3 min-w-[18px] text-center leading-none">
          {count}
        </span>
      )}
      <div className="flex-1 h-px bg-bg-2" />
    </div>
  )
}

function EmptyState({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="flex items-center gap-2 py-4 px-4 text-ink-4 text-sm">
      <Icon size={14} className="shrink-0" />
      {text}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function InboxView({ sessions, onSelectSession, onUploadClick, onScanClick, onSwitchToHistory }: Props) {
  const [priceAlerts, setPriceAlerts]   = useState<PriceAlert[]>([])
  const [recipeAlerts, setRecipeAlerts] = useState<RecipeAlert[]>([])
  const [dismissing, setDismissing]     = useState<Set<string>>(new Set())

  const fetchAlerts = useCallback(async () => {
    try {
      const data = await fetch('/api/invoices/alerts').then(r => r.ok ? r.json() : null)
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
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* ── Page header ───────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 shrink-0">
        <div>
          <h1 className="text-xl font-bold text-ink">Inbox</h1>
          <p className="text-xs text-ink-4 mt-0.5">
            {queue.length > 0
              ? `${queue.length} item${queue.length === 1 ? '' : 's'} need attention`
              : 'Nothing pending'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onScanClick && (
            <button
              onClick={onScanClick}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-white text-xs font-medium text-ink-3 hover:border-gold/40 hover:text-gold transition-colors"
            >
              <FileText size={13} /> Scan
            </button>
          )}
          <button
            onClick={onUploadClick}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink text-xs font-medium text-white hover:bg-ink-2 transition-colors"
          >
            <Upload size={13} /> Upload
          </button>
          <button
            onClick={onSwitchToHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-white text-xs font-medium text-ink-3 hover:text-ink-2 transition-colors"
            title="View all invoices"
          >
            <List size={13} />
            <span className="hidden sm:inline">History</span>
          </button>
        </div>
      </div>

      {/* ── Scrollable body ────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-6">

        {/* ── Queue ──────────────────────────────────────────── */}
        <div>
          <SectionHeader label="Queue" count={queue.length} />
          {queue.length === 0 ? (
            <EmptyState icon={CheckCircle2} text="No pending invoices — all clear." />
          ) : (
            <div className="space-y-2">
              {queue.map(session => {
                const isActive = session.status === 'PROCESSING' || session.status === 'UPLOADING' || session.status === 'APPROVING'
                const isError  = session.status === 'ERROR'
                const canOpen  = session.status === 'REVIEW' || session.status === 'ERROR'

                return (
                  <div
                    key={session.id}
                    onClick={() => canOpen && onSelectSession(session.id)}
                    className={`group relative flex items-center gap-3 p-4 rounded-xl border bg-white transition-all ${
                      canOpen
                        ? 'cursor-pointer hover:border-gold/40 hover:shadow-sm'
                        : 'cursor-default'
                    } ${isError ? 'border-red-soft bg-red-soft' : 'border-line'}`}
                  >
                    {/* Icon */}
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                      isError  ? 'bg-red-soft' :
                      isActive ? 'bg-gold/10' :
                                 'bg-bg-2'
                    }`}>
                      {isActive
                        ? <Loader2 size={15} className="text-gold animate-spin" />
                        : isError
                          ? <AlertTriangle size={15} className="text-red" />
                          : <FileText size={15} className="text-ink-4" />
                      }
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-ink truncate">
                          {session.supplierName ?? 'Unknown supplier'}
                        </p>
                        {session.invoiceNumber && (
                          <span className="text-[10px] text-ink-4 font-mono">#{session.invoiceNumber}</span>
                        )}
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${STATUS_COLOR[session.status] ?? 'bg-bg text-ink-3 border-line'}`}>
                          {STATUS_LABEL[session.status] ?? session.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-ink-4 flex-wrap">
                        {session.invoiceDate && <span>{fmtDate(session.invoiceDate)}</span>}
                        {session.invoiceDate && <span>·</span>}
                        <span>{session._count.scanItems} line{session._count.scanItems === 1 ? '' : 's'}</span>
                        {session.total && (
                          <>
                            <span>·</span>
                            <span className="font-medium text-ink-3">{formatCurrency(parseFloat(String(session.total)))}</span>
                          </>
                        )}
                        {(session._count.priceAlerts > 0 || session._count.recipeAlerts > 0) && (
                          <>
                            <span>·</span>
                            <span className="text-gold">
                              {session._count.priceAlerts + session._count.recipeAlerts} alert{session._count.priceAlerts + session._count.recipeAlerts === 1 ? '' : 's'}
                            </span>
                          </>
                        )}
                        <span className="ml-auto">{fmtAge(session.createdAt)}</span>
                      </div>
                    </div>

                    {/* CTA */}
                    {canOpen && (
                      <ArrowRight size={14} className="text-ink-4 group-hover:text-gold transition-colors shrink-0" />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Price & recipe alerts ──────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <p className="text-[10px] font-semibold tracking-widest uppercase text-ink-4">Price Alerts</p>
              {alertCount > 0 && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gold-soft text-gold-2 min-w-[18px] text-center leading-none">
                  {alertCount}
                </span>
              )}
              <div className="flex-1 h-px bg-bg-2" />
            </div>
            {alertCount > 0 && (
              <button
                onClick={dismissAll}
                className="text-[10px] text-ink-4 hover:text-ink-3 transition-colors ml-3 whitespace-nowrap"
              >
                Dismiss all
              </button>
            )}
          </div>

          {alertCount === 0 ? (
            <EmptyState icon={CheckCircle2} text="No price alerts — all ingredient costs are stable." />
          ) : (
            <div className="space-y-2">
              {priceAlerts.map(alert => (
                <div key={alert.id}
                  className="flex items-center gap-3 p-3.5 rounded-xl border border-gold-soft bg-gold-soft/60">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                    alert.direction === 'UP' ? 'bg-red-soft' : 'bg-green-soft'
                  }`}>
                    {alert.direction === 'UP'
                      ? <TrendingUp size={13} className="text-red" />
                      : <TrendingDown size={13} className="text-green" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">
                      {alert.inventoryItem.itemName}
                    </p>
                    <p className="text-[11px] text-ink-3 mt-0.5">
                      {formatCurrency(Number(alert.previousPrice))} → {formatCurrency(Number(alert.newPrice))}
                      <span className={`ml-1.5 font-semibold ${alert.direction === 'UP' ? 'text-red' : 'text-green'}`}>
                        ({alert.direction === 'UP' ? '+' : ''}{Number(alert.changePct).toFixed(1)}%)
                      </span>
                      {alert.session.supplierName && (
                        <span className="text-ink-4 ml-1.5">· {alert.session.supplierName}</span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => dismissPriceAlert(alert.id)}
                    disabled={dismissing.has(alert.id)}
                    className="p-1 rounded text-ink-4 hover:text-ink-3 transition-colors disabled:opacity-40 shrink-0"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}

              {recipeAlerts.map(alert => (
                <div key={alert.id}
                  className={`flex items-center gap-3 p-3.5 rounded-xl border ${
                    alert.exceededThreshold
                      ? 'border-red-soft bg-red-soft/60'
                      : 'border-gold-soft bg-gold-soft/60'
                  }`}>
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                    alert.exceededThreshold ? 'bg-red-soft' : 'bg-gold-soft'
                  }`}>
                    <ChefHat size={13} className={alert.exceededThreshold ? 'text-red' : 'text-gold'} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">{alert.recipe.name}</p>
                    <p className="text-[11px] text-ink-3 mt-0.5">
                      {alert.exceededThreshold && alert.newFoodCostPct !== null
                        ? <span className="text-red font-semibold">Food cost {(Number(alert.newFoodCostPct) * 100).toFixed(1)}% — exceeds 30% threshold · </span>
                        : null
                      }
                      Cost changed {Number(alert.changePct) > 0 ? '+' : ''}{Number(alert.changePct).toFixed(1)}%
                      {alert.session.supplierName && (
                        <span className="text-ink-4 ml-1.5">· {alert.session.supplierName}</span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => dismissRecipeAlert(alert.id)}
                    disabled={dismissing.has(alert.id)}
                    className="p-1 rounded text-ink-4 hover:text-ink-3 transition-colors disabled:opacity-40 shrink-0"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Recent activity ────────────────────────────────── */}
        {recent.length > 0 && (
          <div>
            <SectionHeader label="Recently approved" count={0} />
            <div className="space-y-1">
              {recent.map(session => (
                <button
                  key={session.id}
                  onClick={() => onSelectSession(session.id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-bg transition-colors text-left group"
                >
                  <CheckCircle2 size={13} className="text-green shrink-0" />
                  <span className="flex-1 text-sm text-ink-3 truncate">
                    {session.supplierName ?? 'Unknown'}
                    {session.invoiceDate ? ` · ${fmtDate(session.invoiceDate)}` : ''}
                  </span>
                  {session.total && (
                    <span className="text-xs text-ink-4 font-medium shrink-0">
                      {formatCurrency(parseFloat(String(session.total)))}
                    </span>
                  )}
                  <Clock size={11} className="text-ink-4 shrink-0" />
                  <span className="text-[10px] text-ink-4 shrink-0">{fmtAge(session.createdAt)}</span>
                </button>
              ))}
            </div>
            <button
              onClick={onSwitchToHistory}
              className="mt-2 flex items-center gap-1.5 text-xs text-gold hover:underline"
            >
              View full history <ArrowRight size={11} />
            </button>
          </div>
        )}

      </div>
    </div>
  )
}
