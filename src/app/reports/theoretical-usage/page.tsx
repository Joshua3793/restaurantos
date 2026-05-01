'use client'
import { useEffect, useState, useCallback } from 'react'
import { formatCurrency } from '@/lib/utils'
import { TrendingDown, AlertTriangle, Info } from 'lucide-react'

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
  const today = new Date().toISOString().slice(0, 10)
  const thirtyDaysAgo = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10) })()

  const [startDate, setStartDate] = useState(thirtyDaysAgo)
  const [endDate, setEndDate]     = useState(today)
  const [rows, setRows]           = useState<Row[]>([])
  const [meta, setMeta]           = useState<Meta | null>(null)
  const [loading, setLoading]     = useState(false)

  const fetch_ = useCallback(() => {
    setLoading(true)
    const p = new URLSearchParams({ startDate, endDate })
    fetch(`/api/reports/theoretical-usage?${p}`)
      .then(r => r.json())
      .then(({ rows, meta }) => { setRows(rows); setMeta(meta) })
      .finally(() => setLoading(false))
  }, [startDate, endDate])

  useEffect(() => { fetch_() }, [fetch_])

  const hasActual = meta?.hasActual ?? false

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Theoretical vs Actual Usage</h1>
          <p className="text-sm text-gray-500 mt-0.5">Compare what recipes should have consumed against actual inventory change</p>
        </div>
      </div>

      {/* Date range */}
      <div className="flex items-center gap-3 flex-wrap">
        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
        <span className="text-gray-400 text-sm">to</span>
        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
      </div>

      {/* KPI cards */}
      {meta && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
            <div className="text-xs text-gray-500 font-medium mb-1">Portions Sold</div>
            <div className="text-2xl font-bold text-gray-900">{meta.totalSales.toLocaleString()}</div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
            <div className="text-xs text-gray-500 font-medium mb-1">Theoretical COGS</div>
            <div className="text-2xl font-bold text-gold">{formatCurrency(meta.totalTheoreticalCost)}</div>
          </div>
          {hasActual && (
            <>
              <div className={`rounded-xl shadow-sm border p-4 ${meta.totalGapCost > 0 ? 'bg-red-50 border-red-100' : 'bg-green-50 border-green-100'}`}>
                <div className="text-xs font-medium mb-1 text-gray-500">Unaccounted Loss</div>
                <div className={`text-2xl font-bold ${meta.totalGapCost > 0 ? 'text-red-700' : 'text-green-700'}`}>
                  {formatCurrency(Math.abs(meta.totalGapCost))}
                </div>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
                <div className="text-xs text-gray-500 font-medium mb-1">Count Sessions</div>
                <div className="text-xs font-medium text-gray-700 leading-snug">
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
        <div className="bg-gold/10 border border-blue-100 rounded-xl p-4 flex items-start gap-3">
          <Info size={18} className="text-blue-500 shrink-0 mt-0.5" />
          <div className="text-sm text-gold">
            <span className="font-semibold">No finalized count sessions found for this range. </span>
            Showing theoretical usage only (from sales × recipe quantities). Finalize count sessions before and after the period to see the actual gap.
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">No sales data found for this period</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Ingredient</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Theoretical Use</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Theoretical Cost</th>
                  {hasActual && (
                    <>
                      <th className="text-right px-4 py-3 font-medium text-gray-600">Actual Use</th>
                      <th className="text-right px-4 py-3 font-medium text-gray-600">Gap</th>
                      <th className="text-right px-4 py-3 font-medium text-gray-600">Gap Cost</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map(row => {
                  const gapIsHigh = row.gapCost !== null && row.gapCost > 20
                  return (
                    <tr key={row.id} className={`hover:bg-gray-50 ${gapIsHigh ? 'bg-red-50/30' : ''}`}>
                      <td className="px-4 py-2.5 font-medium text-gray-800">
                        {gapIsHigh && <TrendingDown size={13} className="inline text-red-500 mr-1 -mt-0.5" />}
                        {row.itemName}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-600">
                        {row.theoreticalQty.toFixed(1)} {row.baseUnit}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                        {formatCurrency(row.theoreticalCost)}
                      </td>
                      {hasActual && (
                        <>
                          <td className="px-4 py-2.5 text-right text-gray-600">
                            {row.actualQty !== null ? `${row.actualQty.toFixed(1)} ${row.baseUnit}` : '—'}
                          </td>
                          <td className={`px-4 py-2.5 text-right font-semibold ${row.gap !== null && row.gap > 0 ? 'text-red-600' : 'text-green-600'}`}>
                            {row.gap !== null ? `${row.gap > 0 ? '+' : ''}${row.gap.toFixed(1)} ${row.baseUnit}` : '—'}
                          </td>
                          <td className={`px-4 py-2.5 text-right font-semibold ${row.gapCost !== null && row.gapCost > 0 ? 'text-red-600' : 'text-green-600'}`}>
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
        <p className="text-xs text-gray-400">
          * Theoretical usage is calculated from sales × recipe ingredient quantities. Positive gap = more consumed than expected (waste/theft/portioning errors). Negative gap = less consumed (over-counting or no sales data).
        </p>
      )}
    </div>
  )
}
