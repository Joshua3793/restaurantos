'use client'
import { useEffect, useState } from 'react'
import { MapPin } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { getVocab } from '@/lib/rc-vocab'

interface RcRow {
  id: string
  name: string
  type: string
  sales: number
  cogs: number
  costPct: number | null
  targetCostPct: number | null
}

interface DashboardData {
  locationId: string
  from: string
  to: string
  totalSales: number
  blendedCostPct: number | null
  blendedTargetPct: number | null
  revenueCenters: RcRow[]
}

const fmtMoney = (n: number) =>
  n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })
const fmtPct = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}%`)

/**
 * Read-only aggregate dashboard for a LOCATION. A location holds no stock — it
 * aggregates its child revenue centers. Each child RC shows its own
 * type-labeled cost line (FOOD → "Food cost %", DRINK → "Pour cost %") so a
 * Cafe with a Kitchen + Bar reads as two honest lines, not a blended "100%
 * food". A revenue-weighted blended COGS % summarizes the whole location.
 *
 * No editable controls — selecting a location is a read-only view.
 */
export function LocationDashboard({ locationId }: { locationId: string }) {
  const { activeLocation } = useRc()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/insights/location-dashboard?locationId=${encodeURIComponent(locationId)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) setData(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [locationId])

  const locName = activeLocation?.name ?? 'Location'

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <span className="grid place-items-center h-8 w-8 rounded-[9px] bg-bg-2 border border-line">
          <MapPin size={16} className="text-ink-3" />
        </span>
        <div>
          <h1 className="text-[20px] font-semibold text-ink leading-tight">{locName}</h1>
          <p className="text-[12px] text-ink-4">
            Read-only · aggregate of revenue centers · week-to-date
          </p>
        </div>
      </div>

      {loading && (
        <div className="font-mono text-[11px] text-ink-3">Loading…</div>
      )}

      {!loading && data && (data.revenueCenters?.length ?? 0) === 0 && (
        <div className="bg-paper border border-line rounded-[12px] p-6 text-center">
          <p className="text-[13px] text-ink-3">No revenue centers in scope for this location yet.</p>
        </div>
      )}

      {!loading && data && (data.revenueCenters?.length ?? 0) > 0 && (
        <>
          {/* Per-RC cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.revenueCenters?.map(rc => {
              const vocab = getVocab(rc.type)
              const overTarget = rc.costPct != null && rc.targetCostPct != null && rc.costPct > rc.targetCostPct
              return (
                <div key={rc.id} className="bg-paper border border-line rounded-[12px] p-5">
                  <div className="flex items-center justify-between">
                    <h2 className="text-[14px] font-semibold text-ink truncate">{rc.name}</h2>
                    <span className="text-[10px] uppercase tracking-wide text-ink-4">
                      {rc.type === 'DRINK' ? '🍸 Drink' : '🍴 Food'}
                    </span>
                  </div>

                  <div className="mt-4">
                    <p className="text-[11px] text-ink-4">{vocab.costPctLabel}</p>
                    <p className={`text-[26px] font-semibold leading-none mt-1 ${overTarget ? 'text-red' : 'text-ink'}`}>
                      {fmtPct(rc.costPct)}
                    </p>
                    {rc.targetCostPct != null && (
                      <p className="text-[11px] text-ink-4 mt-1">
                        {vocab.targetLabel}: {fmtPct(rc.targetCostPct)}
                      </p>
                    )}
                  </div>

                  <div className="mt-4 pt-3 border-t border-line flex items-center justify-between text-[12px]">
                    <span className="text-ink-4">Sales</span>
                    <span className="text-ink-2 font-medium">{fmtMoney(rc.sales)}</span>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Location summary */}
          <div className="bg-paper border border-line rounded-[12px] p-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-[11px] text-ink-4">Blended COGS %</p>
                <p className="text-[24px] font-semibold text-ink leading-none mt-1">
                  {fmtPct(data.blendedCostPct)}
                </p>
                {data.blendedTargetPct != null && (
                  <p className="text-[11px] text-ink-4 mt-1">
                    Blended target: {fmtPct(data.blendedTargetPct)}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="text-[11px] text-ink-4">Total sales</p>
                <p className="text-[24px] font-semibold text-ink leading-none mt-1">
                  {fmtMoney(data.totalSales)}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-ink-4 mt-3 leading-snug">
              Blended COGS % is revenue-weighted across revenue centers. Food and pour
              cost are measured separately, then combined — not summed as one menu.
            </p>
          </div>
        </>
      )}
    </div>
  )
}
