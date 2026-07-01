'use client'
import { useEffect, useState } from 'react'
import { KpiData } from './types'
import { formatCurrency } from '@/lib/utils'
import { setScopeParams } from '@/lib/scope-params'

interface Props {
  refreshKey: number  // increment to trigger a refetch
  scope: {
    activeKind: 'all' | 'location' | 'rc'
    activeRcId: string | null
    activeRc: { isDefault?: boolean } | null
    activeLocationId: string | null
  }
}

/**
 * Branded invoice KPI strip — matches the /pass and /cost pattern.
 *
 * 1.4fr 1fr 1fr 1fr grid:
 *   - Hero (ink bg): This week spend with WoW delta and gold dollar accent
 *   - This month: ink-2 neutral with invoice count
 *   - Awaiting approval: gold-soft when > 0, neutral otherwise
 *   - Price alerts: red-soft when > 0, neutral otherwise
 *
 * Replaces the legacy InvoiceKpiStrip (gray-* tokens, 5-cell horizontal layout
 * including a sparkline that turned into clutter).
 */
export function InvoiceKpiStripV2({ refreshKey, scope }: Props) {
  const [kpis, setKpis] = useState<KpiData | null>(null)
  const { activeKind, activeRcId, activeRc, activeLocationId } = scope

  useEffect(() => {
    const p = new URLSearchParams()
    setScopeParams(p, { activeKind, activeRcId, activeRc, activeLocationId })
    const qs = p.toString()
    fetch(`/api/invoices/kpis${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(data => data && setKpis(data))
      .catch(() => {})
  }, [refreshKey, activeKind, activeRcId, activeRc, activeLocationId])

  return (
    <div className="grid gap-3 mb-5" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr' }}>
      <Hero kpis={kpis} />
      <Card
        label="This month"
        value={kpis ? formatCurrency(kpis.monthSpend) : '—'}
        delta={kpis ? <><b>{kpis.monthInvoiceCount}</b> {kpis.monthInvoiceCount === 1 ? 'invoice' : 'invoices'}</> : <>—</>}
      />
      <Card
        label="Awaiting approval"
        value={kpis ? String(kpis.awaitingApprovalCount) : '—'}
        valueClass={kpis && kpis.awaitingApprovalCount > 0 ? 'text-gold-2' : ''}
        delta={
          kpis && kpis.awaitingApprovalCount > 0
            ? <><b>{kpis.awaitingApprovalCount === 1 ? 'session' : 'sessions'}</b> in queue</>
            : <>all caught up</>
        }
        tint={kpis && kpis.awaitingApprovalCount > 0 ? 'warn' : 'neutral'}
      />
      <Card
        label="Price alerts"
        value={kpis ? String(kpis.priceAlertCount) : '—'}
        valueClass={kpis && kpis.priceAlertCount > 0 ? 'text-red-text' : ''}
        delta={
          kpis && kpis.priceAlertCount > 0
            ? <><b>review</b> · open Price alerts</>
            : <>none active</>
        }
        tint={kpis && kpis.priceAlertCount > 0 ? 'bad' : 'neutral'}
      />
    </div>
  )
}

function Hero({ kpis }: { kpis: KpiData | null }) {
  if (!kpis) {
    return (
      <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px]">
        <div>
          <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">THIS WEEK · INVOICE SPEND</div>
          <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-ink-3">—</div>
        </div>
        <div className="font-mono text-[11px] text-ink-3">loading…</div>
      </div>
    )
  }

  const pct = kpis.weekSpendChangePct
  const trendIs = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'
  const trendCls = trendIs === 'up' ? 'text-red' : trendIs === 'down' ? 'text-green' : 'text-ink-4'
  const arrow = trendIs === 'up' ? '↑' : trendIs === 'down' ? '↓' : '·'

  const formatted = formatCurrency(kpis.weekSpend)
  const [whole, cents] = formatted.split('.')

  return (
    <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px] relative overflow-hidden">
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">THIS WEEK · INVOICE SPEND</div>
        <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2">
          {whole}
          <sub className="text-[18px] font-medium text-gold tracking-[-0.02em] align-baseline">.{cents ?? '00'}</sub>
        </div>
      </div>
      <div className="font-mono text-[11px] text-ink-3 tracking-[0] flex items-center gap-1.5">
        <span className={`font-semibold ${trendCls}`}>{arrow} {Math.abs(pct).toFixed(1)}%</span>
        <span>vs last week</span>
      </div>
    </div>
  )
}

function Card({
  label, value, delta, valueClass = '', tint = 'neutral',
}: {
  label: string
  value: string
  delta: React.ReactNode
  valueClass?: string
  tint?: 'neutral' | 'warn' | 'bad'
}) {
  const cardCls = tint === 'warn'
    ? 'bg-gold-soft border-[#fcd34d]/60'
    : tint === 'bad'
      ? 'bg-red-soft border-red-soft'
      : 'bg-paper border-line'
  const accent = tint === 'warn' ? 'bg-gold-2' : tint === 'bad' ? 'bg-red' : 'bg-gold'

  return (
    <div className={`border rounded-[12px] p-5 flex flex-col justify-between min-h-[128px] relative ${cardCls}`}>
      <div className={`absolute top-0 left-0 w-8 h-0.5 ${accent}`} />
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em] uppercase">{label}</div>
        <div className={`text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 ${valueClass || 'text-ink'}`}>{value}</div>
      </div>
      <div className="font-mono text-[11px] text-ink-3 tracking-[0] [&_b]:text-ink [&_b]:font-medium">{delta}</div>
    </div>
  )
}
