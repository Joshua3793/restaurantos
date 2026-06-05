'use client'
import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { TrendingUp, ArrowRight, BarChart3 } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'
import { ReportsSubnav } from './ReportsSubnav'

interface ChromeData {
  foodCostPct: number | null
  targetPct: number
  variance7d: number | null
  onHand: number
}

interface DashboardData {
  totalInventoryValue: number
  weeklyWastageCost: number
  outOfStockCount: number
  topExpensiveItems: Array<{
    id: string; itemName: string; category: string;
    stockOnHand: number; pricePerBaseUnit: string | number; inventoryValue: number;
    baseUnit: string;
  }>
  weeklyRevenue: number
  weeklyFoodSales: number
  weeklyPurchaseCost: number
  estimatedFoodCostPct: number
}

interface RecipeDriftRow {
  id: string
  name: string
  menuPrice: number
  totalCost: number
  foodCostPct: number
  gapPp: number
}

export default function ReportsPage() {
  const { activeRcId, activeRc } = useRc()
  const [chrome, setChrome] = useState<ChromeData | null>(null)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [recipes, setRecipes] = useState<Array<{ id: string; name: string; menuPrice: number | null; totalCost: number }>>([])

  useEffect(() => {
    const qs = activeRcId ? `?rcId=${activeRcId}&isDefault=${activeRc?.isDefault ?? false}` : ''
    Promise.all([
      fetch(`/api/insights/cost-chrome${activeRcId ? `?rcId=${activeRcId}` : ''}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
      fetch(`/api/reports/dashboard${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
      fetch(`/api/recipes?type=MENU`, { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
    ]).then(([c, d, r]) => {
      if (c) setChrome(c)
      if (d) setDashboard(d)
      if (Array.isArray(r)) setRecipes(r)
    })
  }, [activeRcId, activeRc])

  const target = chrome?.targetPct ?? 27
  const drift = useMemo<RecipeDriftRow[]>(() => {
    return recipes
      .filter(r => r.menuPrice !== null && r.totalCost > 0)
      .map(r => {
        const pct = (r.totalCost / Number(r.menuPrice)) * 100
        return {
          id: r.id, name: r.name,
          menuPrice: Number(r.menuPrice), totalCost: r.totalCost,
          foodCostPct: pct,
          gapPp: pct - target,
        }
      })
      .sort((a, b) => b.gapPp - a.gapPp)
      .slice(0, 10)
  }, [recipes, target])

  return (
    <div>
      <PageHead
        crumbs={<><BarChart3 size={12} /> INSIGHTS / REPORTS</>}
        title="Reports"
        sub={chrome ? <>WTD food cost <b>{chrome.foodCostPct?.toFixed(1) ?? '—'}%</b> vs target <b>{target.toFixed(1)}%</b> · on hand <b>{formatCurrency(chrome.onHand)}</b></> : <>Loading…</>}
      />

      <ReportsSubnav />

      <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr' }}>
        <HeroCard chrome={chrome} target={target} />
        <Card label="WEEKLY REVENUE" value={dashboard ? formatCurrency(dashboard.weeklyRevenue) : '—'} delta={<>WTD</>} />
        <Card label="WEEKLY PURCHASES" value={dashboard ? formatCurrency(dashboard.weeklyPurchaseCost) : '—'} delta={<>numerator</>} />
        <Card label="WASTAGE · 7D"
          value={dashboard ? formatCurrency(dashboard.weeklyWastageCost) : '—'}
          valueClass={dashboard && dashboard.weeklyWastageCost > 0 ? 'text-red-text' : ''}
          delta={<>from log</>}
        />
      </div>

      <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <section className="bg-paper border border-line rounded-[12px] overflow-hidden">
          <header className="flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2">
              <TrendingUp size={13} className="text-gold" />
              Top inventory value drivers
              <span className="font-mono text-[10.5px] text-ink-3 font-normal">· top 10</span>
            </h3>
            <Link href="/inventory" className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current">Open inventory →</Link>
          </header>
          {!dashboard ? (
            <div className="p-6 text-center text-ink-3 font-mono text-[11px]">Loading…</div>
          ) : (
            <div className="divide-y divide-line">
              {dashboard.topExpensiveItems.map(it => (
                <Link key={it.id} href={`/inventory?highlight=${it.id}`}
                  className="grid grid-cols-[1fr_auto] gap-3 px-[18px] py-2.5 items-center hover:bg-bg-2/40 transition-colors">
                  <div className="min-w-0">
                    <div className="text-[13px] text-ink font-medium tracking-[-0.005em] truncate">{it.itemName}</div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                      {it.category} · {Number(it.stockOnHand).toFixed(1)} {it.baseUnit} × ${Number(it.pricePerBaseUnit).toFixed(4)}
                    </div>
                  </div>
                  <div className="font-mono text-[13px] text-ink font-medium tabular-nums">{formatCurrency(it.inventoryValue)}</div>
                </Link>
              ))}
            </div>
          )}
          <div className="px-[18px] py-2.5 font-mono text-[10.5px] text-ink-3 border-t border-line bg-bg-2/40 flex justify-end">
            <Link href="/inventory" className="text-gold-2 inline-flex items-center gap-1">Open repricing <ArrowRight size={11} /></Link>
          </div>
        </section>

        <section className="bg-paper border border-line rounded-[12px] overflow-hidden">
          <header className="flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2">
              <BarChart3 size={13} className="text-red" />
              Recipe drift · over target by &gt;3pp
              <span className="font-mono text-[10.5px] text-ink-3 font-normal">· top {drift.length}</span>
            </h3>
            <Link href="/signals" className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current">Open signals →</Link>
          </header>
          {drift.length === 0 ? (
            <div className="p-6 text-center text-ink-3 font-mono text-[11px]">No recipes over target — your costs are dialed.</div>
          ) : (
            <div className="divide-y divide-line">
              {drift.map(r => {
                const tone = r.gapPp > 6 ? 'bad' : r.gapPp > 3 ? 'warn' : 'ok'
                const toneCls = tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-green-text'
                return (
                  <Link key={r.id} href={`/menu?highlight=${r.id}`}
                    className="grid grid-cols-[1fr_auto_auto] gap-3 px-[18px] py-2.5 items-center hover:bg-bg-2/40 transition-colors">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink font-medium truncate">{r.name}</div>
                      <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                        cost {formatCurrency(r.totalCost)} · price {formatCurrency(r.menuPrice)}
                      </div>
                    </div>
                    <div className={`font-mono text-[13px] font-semibold tabular-nums ${toneCls}`}>
                      {r.foodCostPct.toFixed(1)}%
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 text-gold-2 inline-flex items-center gap-1">
                      Reprice <ArrowRight size={10} />
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <div className="mt-5 font-mono text-[10.5px] text-ink-3 tracking-wide text-center">
        Detailed analytics live in the tabs above. <kbd className="bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘R</kbd> refresh.
      </div>
    </div>
  )
}

function HeroCard({ chrome, target }: { chrome: ChromeData | null; target: number }) {
  const pct = chrome?.foodCostPct ?? null
  const intStr = pct !== null ? Math.floor(pct).toString() : '—'
  const decStr = pct !== null ? `.${(pct % 1).toFixed(1).slice(2)}%` : ''
  return (
    <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px] relative overflow-hidden">
      <div>
        <div className="font-mono text-[10.5px] text-zinc-500 tracking-[0.01em]">FOOD COST · WEEK TO DATE</div>
        <div className="text-[48px] font-semibold tracking-[-0.045em] leading-none mt-2">
          {intStr}<sub className="text-[22px] font-medium text-gold tracking-[-0.02em] align-baseline">{decStr}</sub>
        </div>
      </div>
      <div className="font-mono text-[11px] text-zinc-500 tracking-[0]">
        target <b className="text-paper">{target.toFixed(1)}</b>
        {pct !== null && <> · <span className={pct > target ? 'text-[#fca5a5]' : 'text-[#4ade80]'}>{pct > target ? '+' : ''}{(pct - target).toFixed(1)}</span></>}
      </div>
    </div>
  )
}

function Card({ label, value, delta, valueClass = '' }: { label: string; value: string; delta: React.ReactNode; valueClass?: string }) {
  return (
    <div className="bg-paper border border-line rounded-[12px] p-5 flex flex-col justify-between min-h-[128px] relative">
      <div className="absolute top-0 left-0 w-8 h-0.5 bg-gold" />
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em] uppercase">{label}</div>
        <div className={`text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 ${valueClass || 'text-ink'}`}>{value}</div>
      </div>
      <div className="font-mono text-[11px] text-ink-3 tracking-[0] [&_b]:text-ink [&_b]:font-medium">{delta}</div>
    </div>
  )
}
