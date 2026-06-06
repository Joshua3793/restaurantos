'use client'
import { useState, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { SectionHeader, Card, LoadingState } from '../report-components'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

interface CogsResult {
  startDate: string; endDate: string
  beginningInventory: { value: number; sessionDate: string | null; sessionId: string | null; fallback: boolean }
  purchases: { total: number; invoiceCount: number }
  endingInventory: { value: number; sessionDate: string | null; sessionId: string | null; fallback: boolean }
  cogs: number; foodSales: number; foodCostPct: number
  byCategory: Array<{ category: string; beginningValue: number; endingValue: number; purchases: number; cogs: number }>
}

export default function CogsTab() {
  const { activeRcId, activeRc } = useRc()
  const getWeekBounds = () => {
    const today = new Date(), dow = today.getDay()
    const mon = new Date(today); mon.setDate(today.getDate() - ((dow + 6) % 7))
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
    return { start: mon.toISOString().split('T')[0], end: sun.toISOString().split('T')[0] }
  }
  const { start: defaultStart, end: defaultEnd } = getWeekBounds()
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate]     = useState(defaultEnd)
  const [data, setData] = useState<CogsResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ startDate, endDate })
      if (activeRcId) {
        params.set('rcId', activeRcId)
        if (activeRc?.isDefault) params.set('isDefault', 'true')
      }
      const res = await fetch(`/api/reports/cogs?${params}`)
      setData(await res.json())
    } finally { setLoading(false) }
  }, [startDate, endDate, activeRcId, activeRc])

  const fcColor = (pct: number) => pct < 28 ? 'text-green-text' : pct < 35 ? 'text-gold' : 'text-red'

  return (
    <div className="space-y-6">
      {/* Date selector */}
      <Card>
        <SectionHeader title="COGS Calculator" subtitle="Beginning Inventory + Purchases − Ending Inventory" />
        <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">Start Date</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">End Date</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 bg-ink text-paper [&_svg]:text-gold px-4 py-2 rounded-lg text-sm hover:bg-ink-2 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Calculating…' : 'Calculate COGS'}
          </button>
          {activeRc && (
            <div className="flex items-center gap-1.5 text-xs text-ink-3">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(activeRc.color) }} />
              {activeRc.name}
            </div>
          )}
        </div>
      </Card>

      {loading && <LoadingState />}

      {data && (
        <>
          {/* Formula Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-center">
            <Card className="text-center">
              <div className="text-xs font-medium text-ink-3 mb-1">Beginning Inventory</div>
              <div className="text-xl font-bold text-ink-2">{formatCurrency(data.beginningInventory.value)}</div>
              {data.beginningInventory.fallback && <div className="text-[10px] text-gold mt-1">⚠ estimated</div>}
              {data.beginningInventory.sessionDate && <div className="text-[10px] text-ink-4 mt-1">{data.beginningInventory.sessionDate}</div>}
            </Card>
            <div className="flex items-center justify-center text-2xl font-light text-ink-4">+</div>
            <Card className="text-center">
              <div className="text-xs font-medium text-ink-3 mb-1">Purchases</div>
              <div className="text-xl font-bold text-ink-2">{formatCurrency(data.purchases.total)}</div>
              <div className="text-[10px] text-ink-4 mt-1">{data.purchases.invoiceCount} invoices</div>
            </Card>
            <div className="hidden sm:flex items-center justify-center text-2xl font-light text-ink-4">−</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-center">
            <div className="hidden sm:block" />
            <div className="hidden sm:block" />
            <Card className="text-center">
              <div className="text-xs font-medium text-ink-3 mb-1">Ending Inventory</div>
              <div className="text-xl font-bold text-ink-2">{formatCurrency(data.endingInventory.value)}</div>
              {data.endingInventory.fallback && <div className="text-[10px] text-gold mt-1">⚠ estimated</div>}
              {data.endingInventory.sessionDate && <div className="text-[10px] text-ink-4 mt-1">{data.endingInventory.sessionDate}</div>}
            </Card>
            <Card className="text-center border-gold/30 bg-gold/10">
              <div className="text-xs font-semibold text-gold mb-1">= COGS</div>
              <div className="text-2xl font-bold text-gold">{formatCurrency(data.cogs)}</div>
              {data.foodSales > 0 && (
                <div className={`text-lg font-bold mt-1 ${fcColor(data.foodCostPct)}`}>{data.foodCostPct.toFixed(1)}% food cost</div>
              )}
            </Card>
          </div>

          {/* Category Breakdown */}
          {data.byCategory?.length > 0 && (
            <Card>
              <SectionHeader title="COGS by Category" />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-line">
                      {['Category','Beginning','Purchases','Ending','COGS'].map(h => (
                        <th key={h} className={`py-2 pr-3 text-xs font-semibold text-ink-3 ${h !== 'Category' ? 'text-right' : ''}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.byCategory.map(row => (
                      <tr key={row.category} className="border-b border-line hover:bg-bg/60">
                        <td className="py-2.5 pr-3 font-medium text-ink-2">{row.category}</td>
                        <td className="py-2.5 pr-3 text-right text-ink-3">{formatCurrency(row.beginningValue)}</td>
                        <td className="py-2.5 pr-3 text-right text-ink-3">{formatCurrency(row.purchases)}</td>
                        <td className="py-2.5 pr-3 text-right text-ink-3">{formatCurrency(row.endingValue)}</td>
                        <td className="py-2.5 text-right font-semibold text-ink-2">{formatCurrency(row.cogs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
