'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Zap, Check, Clock, X, RefreshCw, AlertTriangle, AlertCircle, Info } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface Signal {
  id: string
  fingerprint: string
  rule: string
  severity: 'critical' | 'warn' | 'info'
  title: string
  body: string
  verbLabel: string
  verbHref: string
  impactValue: number | null
  itemId: string | null
  recipeId: string | null
  status: 'OPEN' | 'APPLIED' | 'SNOOZED' | 'DISMISSED'
  createdAt: string
}

interface SignalsData {
  signals: Signal[]
  counts: { open: number; applied: number; critical: number }
}

export default function SignalsPage() {
  const [data, setData] = useState<SignalsData | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const json: SignalsData = await fetch('/api/signals', { cache: 'no-store' }).then(r => r.json())
      setData(json)
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await fetch('/api/signals/refresh', { method: 'POST' })
      await load()
    } finally { setRefreshing(false) }
  }

  const act = async (id: string, action: 'apply' | 'snooze' | 'dismiss') => {
    setBusyId(id)
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], action }),
      })
      await load()
    } finally { setBusyId(null) }
  }

  const open    = data?.signals.filter(s => s.status === 'OPEN')    ?? []
  const applied = data?.signals.filter(s => s.status === 'APPLIED') ?? []

  return (
    <div>
      <PageHead
        crumbs={<span>INSIGHTS / SIGNALS</span>}
        title="Signals"
        sub={
          data
            ? <>
                <b>{data.counts.open}</b> open
                {data.counts.critical > 0 && <> · <b className="text-red-text">{data.counts.critical} critical</b></>}
                {data.counts.applied > 0 && <> · <b>{data.counts.applied}</b> applied</>}
              </>
            : <>Loading…</>
        }
        actions={
          <button
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 bg-ink text-paper px-4 py-[9px] rounded-[9px] text-[13px] font-medium hover:bg-[#18181b] disabled:opacity-60 transition-colors"
          >
            <RefreshCw size={13} className={`text-gold ${refreshing ? 'animate-spin' : ''}`} /> {refreshing ? 'Refreshing…' : 'Refresh signals'}
          </button>
        }
      />

      {!data ? null : (open.length + applied.length === 0) ? (
        <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All quiet</p>
          <p className="text-[14px] text-ink-2 mt-2 max-w-md mx-auto">
            No active signals. Run <b>Refresh</b> to re-evaluate the rules
            (price spikes, recipe drift, count overdue, wastage, menu engineering).
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {open.length > 0 && (
            <section>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Open · {open.length}</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {open.map(s => (
                  <SignalCard key={s.id} signal={s} busy={busyId === s.id} onAct={act} />
                ))}
              </div>
            </section>
          )}
          {applied.length > 0 && (
            <section>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Applied · {applied.length}</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {applied.map(s => (
                  <SignalCard key={s.id} signal={s} busy={busyId === s.id} onAct={act} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <div className="mt-5 font-mono text-[10.5px] text-ink-3 tracking-wide text-center">
        5 starter rules: price spikes · recipe drift · count overdue · wastage spikes · menu engineering
      </div>
    </div>
  )
}

function SignalCard({ signal, busy, onAct }: {
  signal: Signal; busy: boolean; onAct: (id: string, action: 'apply' | 'snooze' | 'dismiss') => void
}) {
  const sev = signal.severity
  const Icon = sev === 'critical' ? AlertTriangle : sev === 'warn' ? AlertCircle : Info
  const iconCls = sev === 'critical' ? 'bg-red-soft text-red-text'
    : sev === 'warn' ? 'bg-gold-soft text-gold-2'
    : 'bg-blue-soft text-blue-text'
  const isApplied = signal.status === 'APPLIED'

  return (
    <div className={`bg-paper border rounded-[12px] p-5 transition-opacity ${isApplied ? 'opacity-70 border-line' : 'border-line'}`}>
      <header className="flex items-start gap-3 mb-3">
        <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${iconCls}`}>
          <Icon size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink leading-tight">{signal.title}</div>
          <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0.02em] uppercase">
            {signal.rule.replaceAll('_', ' ')}
            {signal.impactValue !== null && signal.impactValue > 0 && (
              <> · <span className="text-gold-2 normal-case tracking-normal font-semibold">{formatCurrency(signal.impactValue)} est.</span></>
            )}
          </div>
        </div>
        {isApplied && (
          <span className="font-mono text-[10px] uppercase tracking-[0.04em] bg-green-soft text-green-text px-2 py-0.5 rounded-full font-semibold">
            Applied
          </span>
        )}
      </header>

      <p className="text-[13px] text-ink-2 leading-[1.5] tracking-[-0.005em] mb-4">
        {signal.body}
      </p>

      <div className="flex items-center justify-between gap-2">
        <Link href={signal.verbHref}
          className="inline-flex items-center gap-1.5 bg-ink text-paper px-3 py-1.5 rounded-[8px] text-[12px] font-medium hover:bg-[#18181b] transition-colors">
          {signal.verbLabel} →
        </Link>
        <div className="flex items-center gap-1">
          {!isApplied && (
            <button onClick={() => onAct(signal.id, 'apply')} disabled={busy}
              title="Mark applied"
              className="w-8 h-8 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors">
              <Check size={14} />
            </button>
          )}
          <button onClick={() => onAct(signal.id, 'snooze')} disabled={busy}
            title="Snooze 24h"
            className="w-8 h-8 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors">
            <Clock size={14} />
          </button>
          <button onClick={() => onAct(signal.id, 'dismiss')} disabled={busy}
            title="Dismiss"
            className="w-8 h-8 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
