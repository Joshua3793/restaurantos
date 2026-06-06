'use client'
import { useEffect, useState } from 'react'
import { KpiData } from './types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  refreshKey: number  // increment to trigger a refetch
  activeRcId: string | null
  isDefault: boolean
}

export function InvoiceKpiStrip({ refreshKey, activeRcId, isDefault }: Props) {
  const [kpis, setKpis] = useState<KpiData | null>(null)

  useEffect(() => {
    const p = new URLSearchParams()
    if (activeRcId) {
      p.set('rcId', activeRcId)
      if (isDefault) p.set('isDefault', 'true')
    }
    const qs = p.toString()
    fetch(`/api/invoices/kpis${qs ? `?${qs}` : ''}`)
      .then(r => r.json())
      .then(setKpis)
      .catch(() => {})
  }, [refreshKey, activeRcId, isDefault])

  const fmt = (n: number | undefined) =>
    n !== undefined ? formatCurrency(n) : '—'

  return (
    <div className="flex gap-2 px-4 py-2 bg-bg border-b border-line overflow-x-auto shrink-0">

      {/* This Week */}
      <div className="flex-1 min-w-[130px] bg-white border border-line rounded-lg px-3 py-2">
        <p className="text-[10px] text-ink-4 uppercase tracking-wide">This Week</p>
        <p className="text-base font-bold text-ink leading-tight">{fmt(kpis?.weekSpend)}</p>
        {kpis && (
          <p className={`text-[10px] ${kpis.weekSpendChangePct >= 0 ? 'text-green' : 'text-red'}`}>
            {kpis.weekSpendChangePct >= 0 ? '↑' : '↓'} {Math.abs(kpis.weekSpendChangePct)}% vs last week
          </p>
        )}
      </div>

      {/* This Month */}
      <div className="flex-1 min-w-[130px] bg-white border border-line rounded-lg px-3 py-2">
        <p className="text-[10px] text-ink-4 uppercase tracking-wide">This Month</p>
        <p className="text-base font-bold text-ink leading-tight">{fmt(kpis?.monthSpend)}</p>
        <p className="text-[10px] text-ink-4">{kpis?.monthInvoiceCount ?? '—'} invoices</p>
      </div>

      {/* Price Alerts */}
      <div className={`flex-1 min-w-[120px] rounded-lg px-3 py-2 border ${kpis && kpis.priceAlertCount > 0 ? 'bg-gold-soft border-gold-soft' : 'bg-white border-line'}`}>
        <p className={`text-[10px] uppercase tracking-wide ${kpis && kpis.priceAlertCount > 0 ? 'text-gold-2' : 'text-ink-4'}`}>Price Alerts</p>
        <p className={`text-base font-bold leading-tight ${kpis && kpis.priceAlertCount > 0 ? 'text-gold-2' : 'text-ink'}`}>
          {kpis?.priceAlertCount ?? '—'} items
        </p>
      </div>

      {/* Awaiting Approval */}
      <div className={`flex-1 min-w-[140px] rounded-lg px-3 py-2 border ${kpis && kpis.awaitingApprovalCount > 0 ? 'bg-gold/10 border-gold/30' : 'bg-white border-line'}`}>
        <p className={`text-[10px] uppercase tracking-wide ${kpis && kpis.awaitingApprovalCount > 0 ? 'text-gold' : 'text-ink-4'}`}>Awaiting Approval</p>
        <p className={`text-base font-bold leading-tight ${kpis && kpis.awaitingApprovalCount > 0 ? 'text-gold' : 'text-ink'}`}>
          {kpis?.awaitingApprovalCount ?? '—'} sessions
        </p>
      </div>

      {/* Top Spend */}
      <div className="flex-[2] min-w-[180px] bg-white border border-line rounded-lg px-3 py-2">
        <p className="text-[10px] text-ink-4 uppercase tracking-wide mb-1.5">Top Spend</p>
        {kpis?.topCategories.length ? (
          <div className="space-y-1">
            {kpis.topCategories.map(({ category, spend }, i) => {
              const max = kpis.topCategories[0].spend
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[9px] text-ink-3 w-14 truncate">{category}</span>
                  <div className="flex-1 h-1 bg-bg-2 rounded-full">
                    <div
                      className="h-full bg-blue rounded-full"
                      style={{ width: `${(spend / max) * 100}%` }}
                    />
                  </div>
                  <span className="text-[9px] font-semibold text-ink-2 w-10 text-right">
                    ${(spend / 1000).toFixed(1)}k
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-[10px] text-ink-4">—</p>
        )}
      </div>

    </div>
  )
}
