'use client'
import { useEffect, useState, useCallback } from 'react'
import { formatCurrency } from '@/lib/utils'
import { TrendingDown, Info, ClipboardList, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { useRc } from '@/contexts/RevenueCenterContext'
import { DateRangePicker, analyticsParams } from '@/components/reports/DateRangePicker'
import { useReportRange } from '@/lib/report-range'
import { InfoDot } from '../report-components'
import { PROVENANCE } from '@/lib/report-provenance'

interface Row {
  id: string
  itemName: string
  baseUnit: string
  theoreticalQty: number
  actualQty: number | null
  gap: number | null
  theoreticalCost: number
  gapCost: number | null
}

interface Meta {
  totalSales: number
  totalTheoreticalCost: number
  totalGapCost: number
  hasActual: boolean
  openingLabel: string | null
  closingLabel: string | null
}

export default function TheoreticalUsagePage() {
  const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()
  const [range, setRange]         = useReportRange()
  const [rows, setRows]           = useState<Row[]>([])
  const [meta, setMeta]           = useState<Meta | null>(null)
  const [loading, setLoading]     = useState(false)

  const fetch_ = useCallback(() => {
    setLoading(true)
    // Shared reports range (from/to) + active RC/Location scope.
    const p = analyticsParams(range, { activeKind, activeRcId, activeRc, activeLocationId })
    fetch(`/api/reports/theoretical-usage?${p}`)
      .then(r => r.json())
      .then(({ rows, meta }) => { setRows(rows); setMeta(meta) })
      .finally(() => setLoading(false))
  }, [range, activeKind, activeRcId, activeRc, activeLocationId])

  useEffect(() => { fetch_() }, [fetch_])

  const hasActual = meta?.hasActual ?? false

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-ink">Theoretical vs Actual Usage</h1>
          <p className="text-sm text-ink-3 mt-0.5">Compare what recipes should have consumed against actual inventory change</p>
        </div>
      </div>

      {/* Shared reports date range */}
      <DateRangePicker value={range} onChange={setRange} />

      {/* KPI cards */}
      {meta && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl shadow-sm border border-line p-4">
            <div className="text-xs text-ink-3 font-medium mb-1 inline-flex items-center gap-1">Portions Sold <InfoDot text={PROVENANCE.tuPortionsSold} /></div>
            <div className="text-2xl font-bold text-ink">{meta.totalSales.toLocaleString()}</div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-line p-4">
            <div className="text-xs text-ink-3 font-medium mb-1 inline-flex items-center gap-1">Theoretical COGS <InfoDot text={PROVENANCE.tuTheoreticalCost} /></div>
            <div className="text-2xl font-bold text-gold">{formatCurrency(meta.totalTheoreticalCost)}</div>
          </div>
          {hasActual && (
            <>
              <div className={`rounded-xl shadow-sm border p-4 ${meta.totalGapCost > 0 ? 'bg-red-soft border-red-soft' : 'bg-green-soft border-green-soft'}`}>
                <div className="text-xs font-medium mb-1 text-ink-3 inline-flex items-center gap-1">Unaccounted Loss <InfoDot text={PROVENANCE.tuUnaccountedLoss} /></div>
                <div className={`text-2xl font-bold ${meta.totalGapCost > 0 ? 'text-red-text' : 'text-green-text'}`}>
                  {formatCurrency(Math.abs(meta.totalGapCost))}
                </div>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-line p-4">
                <div className="text-xs text-ink-3 font-medium mb-1">Count Sessions</div>
                <div className="text-xs font-medium text-ink-2 leading-snug">
                  <div>Opening: {meta.openingLabel ?? '—'}</div>
                  <div>Closing: {meta.closingLabel ?? '—'}</div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* No actual data notice */}
      {!hasActual && meta && (
        <div className="bg-gold/10 border border-blue-soft rounded-xl p-4 flex items-start gap-3">
          <Info size={18} className="text-blue shrink-0 mt-0.5" />
          <div className="text-sm text-gold">
            <span className="font-semibold">No finalized count sessions found for this range. </span>
            Showing theoretical usage only (from sales × recipe quantities). Finalize count sessions before and after the period to see the actual gap.
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-line overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-ink-4 text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-ink-4 text-sm">No sales data found for this period</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg border-b border-line">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-ink-3">Ingredient</th>
                  <th className="text-right px-4 py-3 font-medium text-ink-3">Theoretical Use</th>
                  <th className="text-right px-4 py-3 font-medium text-ink-3">Theoretical Cost</th>
                  {hasActual && (
                    <>
                      <th className="text-right px-4 py-3 font-medium text-ink-3">Actual Use</th>
                      <th className="text-right px-4 py-3 font-medium text-ink-3">Gap</th>
                      <th className="text-right px-4 py-3 font-medium text-ink-3">Gap Cost</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map(row => {
                  const gapIsHigh = row.gapCost !== null && row.gapCost > 20
                  return (
                    <tr key={row.id} className={`hover:bg-bg ${gapIsHigh ? 'bg-red-soft/30' : ''}`}>
                      <td className="px-4 py-2.5 font-medium text-ink-2">
                        {gapIsHigh && <TrendingDown size={13} className="inline text-red mr-1 -mt-0.5" />}
                        {row.itemName}
                      </td>
                      <td className="px-4 py-2.5 text-right text-ink-3">
                        {row.theoreticalQty.toFixed(1)} {row.baseUnit}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-ink-2">
                        {formatCurrency(row.theoreticalCost)}
                      </td>
                      {hasActual && (
                        <>
                          <td className="px-4 py-2.5 text-right text-ink-3">
                            {row.actualQty !== null ? `${row.actualQty.toFixed(1)} ${row.baseUnit}` : '—'}
                          </td>
                          <td className={`px-4 py-2.5 text-right font-semibold ${row.gap !== null && row.gap > 0 ? 'text-red' : 'text-green'}`}>
                            {row.gap !== null ? `${row.gap > 0 ? '+' : ''}${row.gap.toFixed(1)} ${row.baseUnit}` : '—'}
                          </td>
                          <td className={`px-4 py-2.5 text-right font-semibold ${row.gapCost !== null && row.gapCost > 0 ? 'text-red' : 'text-green'}`}>
                            {row.gapCost !== null ? formatCurrency(Math.abs(row.gapCost)) : '—'}
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <p className="text-xs text-ink-4">
          * Theoretical usage is calculated from sales × recipe ingredient quantities. Positive gap = more consumed than expected (waste/theft/portioning errors). Negative gap = less consumed (over-counting or no sales data).
        </p>
      )}

      {/* ── Next action CTA ─────────────────────────────────── */}
      <div className="flex items-center gap-4 p-4 rounded-xl border border-line bg-white">
        <div className="w-9 h-9 rounded-lg bg-ink flex items-center justify-center shrink-0">
          <ClipboardList size={16} className="text-gold" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-ink">
            {meta?.hasActual
              ? 'Variance calculated — schedule your next count'
              : 'No actual data yet — run a stock count to see real variance'}
          </p>
          <p className="text-xs text-ink-4 mt-0.5">
            Counts reconcile theoretical usage against what&apos;s physically on the shelf.
          </p>
        </div>
        <Link
          href="/count"
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-ink text-gold text-xs font-semibold hover:bg-ink-2 transition-colors shrink-0"
        >
          Go to Count <ArrowRight size={12} />
        </Link>
      </div>
    </div>
  )
}
