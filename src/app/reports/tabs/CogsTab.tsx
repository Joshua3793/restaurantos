'use client'
import { useState, useEffect } from 'react'
import { formatCurrency } from '@/lib/utils'
import { SectionHeader, Card, LoadingState } from '../report-components'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'
import { getVocab } from '@/lib/rc-vocab'
import { rcHex } from '@/lib/rc-colors'
import { DateRangePicker, rangeForPreset, type DateRange } from '@/components/reports/DateRangePicker'

interface InvBound { value: number; sessionDate: string | null; sessionId: string | null; needsCount: boolean; sameAsOpening?: boolean }
interface CogsResult {
  startDate: string; endDate: string
  beginningInventory: InvBound
  purchases: { total: number; invoiceCount: number }
  endingInventory: InvBound
  scope: 'all' | 'default' | 'rc'
  cogs: number; foodSales: number; foodCostPct: number
  byCategory: Array<{ category: string; beginningValue: number; endingValue: number; purchases: number; cogs: number }>
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
// sessionDate is a date-only value stored at UTC midnight — render in UTC so a count
// dated Jun 1 doesn't display as "May 31" in a behind-UTC timezone.
const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** Beginning / Ending inventory card — shows the counted value or an honest "needs count" state. */
function InventoryCard({ label, bound, rcName }: { label: string; bound: InvBound; rcName: string }) {
  return (
    <Card className="text-center">
      <div className="text-xs font-medium text-ink-3 mb-1">{label}</div>
      {bound.needsCount ? (
        <>
          <div className="text-xl font-bold text-ink-4">—</div>
          <div className="text-[10px] text-gold mt-1">No full count for {rcName}</div>
        </>
      ) : (
        <>
          <div className="text-xl font-bold text-ink-2">{formatCurrency(bound.value)}</div>
          {bound.sessionDate && <div className="text-[10px] text-ink-4 mt-1">counted {fmtDate(bound.sessionDate)}</div>}
          {bound.sameAsOpening && <div className="text-[10px] text-gold mt-1">assumes unchanged — run an end count</div>}
        </>
      )}
    </Card>
  )
}

export default function CogsTab() {
  const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()
  // Type-driven cost noun: RC type → "food cost" / "pour cost"; Location/all → "cost".
  const costNounLower = activeKind === 'rc'
    ? getVocab(activeRc?.type).costPctLabel.replace(/ %$/, '').toLowerCase()
    : 'cost'
  const [range, setRange] = useState<DateRange>(() => rangeForPreset('thisWeek'))
  const [data, setData] = useState<CogsResult | null>(null)
  const [loading, setLoading] = useState(false)

  // Auto-recompute whenever the range or revenue center changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ startDate: ymd(range.from), endDate: ymd(range.to) })
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
    fetch(`/api/reports/cogs?${params}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setData(d) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range, activeRcId, activeRc, activeKind, activeLocationId])

  const fcColor = (pct: number) => pct < 28 ? 'text-green-text' : pct < 35 ? 'text-gold' : 'text-red'
  const rcName = activeRc ? activeRc.name : 'All RCs'

  return (
    <div className="space-y-6">
      <Card>
        <SectionHeader title="COGS Calculator" subtitle="Beginning Inventory + Purchases − Ending Inventory · from full counts" />
        <DateRangePicker value={range} onChange={setRange} />
        <div className="flex items-center gap-1.5 text-xs text-ink-3 mt-1">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: activeRc ? rcHex(activeRc.color) : '#9ca3af' }} />
          {rcName}{!activeRc && ' · global'}
        </div>
      </Card>

      {loading && !data && <LoadingState />}

      {data && (
        <>
          {/* Formula Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-center">
            <InventoryCard label="Beginning Inventory" bound={data.beginningInventory} rcName={rcName} />
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
            <InventoryCard label="Ending Inventory" bound={data.endingInventory} rcName={rcName} />
            <Card className="text-center border-gold/30 bg-gold/10">
              <div className="text-xs font-semibold text-gold mb-1">= COGS</div>
              <div className="text-2xl font-bold text-gold">{formatCurrency(data.cogs)}</div>
              {data.foodSales > 0 && (
                <div className={`text-lg font-bold mt-1 ${fcColor(data.foodCostPct)}`}>{data.foodCostPct.toFixed(1)}% {costNounLower}</div>
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
