'use client'
import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Mail, Activity, Zap, Clock,
  ArrowRight, ClipboardList,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { getVocab } from '@/lib/rc-vocab'
import { useUser } from '@/contexts/UserContext'
import { formatCurrency } from '@/lib/utils'
import { startOfWeek } from '@/lib/dates'
import { SubNav } from '@/components/layout/SubNav'
import { PageHead } from '@/components/layout/PageHead'

// ── Types ───────────────────────────────────────────────────────────────────

interface DashboardData {
  totalInventoryValue: number
  weeklyWastageCost: number
  outOfStockCount: number
  outOfStockItems: Array<{ id: string; itemName: string; category: string; lastValue: number }>
  estimatedFoodCostPct: number
  weeklyRevenue: number
  weeklyPurchaseCost: number
  purchaseFoodCostPct: number | null
  theoreticalFoodCostPct: number | null
  theoreticalCoverage: { costed: number; total: number }
  wastagePctOfSales: number | null
  coversWTD: number
  avgCheck: number | null
  revPerCover: number | null
  costPerCover: number | null
}

interface KPIs {
  awaitingApprovalCount: number
  priceAlertCount: number
  recentApprovalsCount: number
}

interface CostChromeData {
  foodCostPct: number | null
  targetPct: number
  variance7d: number | null
  onHand: number
}

interface PrepItem {
  id: string
  name: string
  category: string
  unit: string
  onHand: number
  parLevel: number
  priority: '911' | 'NEEDED_TODAY' | 'LATER'
  suggestedQty: number
}

interface CountSession {
  id: string
  label: string
  sessionDate: string
  startedAt: string
  finalizedAt: string | null
  countedBy: string
  status: string
}

interface AttnItem {
  id: string
  kind: 'price' | 'invoice' | 'variance' | 'count'
  icon: typeof AlertTriangle
  iconTint: 'red' | 'amber' | 'blue' | 'green'
  title: React.ReactNode
  meta: string
  cost: { value: string; sub: string; tint?: 'bad' | 'warn' | 'ok' }
  ctaHref: string
  ctaLabel: string
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function PassPage() {
  const { user } = useUser()
  const { activeRcId, activeRc, activeKind } = useRc()
  const isDefaultActive = activeRc?.isDefault ?? false
  // Type-driven cost noun: an RC carries a FOOD/DRINK type → "FOOD COST" /
  // "POUR COST"; a Location or "all" view spans types → generic "COST".
  const costNoun = activeKind === 'rc'
    ? getVocab(activeRc?.type).costPctLabel.replace(/ %$/, '').toUpperCase()
    : 'COST'
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [chrome, setChrome] = useState<CostChromeData | null>(null)
  const [inboxKpis, setInboxKpis] = useState<KPIs | null>(null)
  const [prepItems, setPrepItems] = useState<PrepItem[]>([])
  const [countSessions, setCountSessions] = useState<CountSession[]>([])
  const [priceAlertCount, setPriceAlertCount] = useState<number>(0)
  const [fcVariance, setFcVariance] = useState<{
    needsCounts: boolean
    actualFoodCostPct?: number | null
    theoreticalFoodCostPct?: number | null
    variancePctPoints?: number | null
    varianceDollars?: number
    period?: { startDate: string; endDate: string }
  } | null>(null)
  const [invEff, setInvEff] = useState<{ daysOnHand: number | null; turnsAnnual: number | null } | null>(null)
  const [cogs, setCogs] = useState<{
    actualFoodCostPct: number | null
    theoreticalFoodCostPct: number | null
    foodCostVariancePts: number | null
    beginningInventory?: { needsCount: boolean; sessionDate: string | null }
    endingInventory?: { needsCount: boolean; sameAsOpening: boolean; sessionDate: string | null }
    rcCoverage?: { total: number; counted: number; uncounted: string[] } | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const qs = activeRcId ? `?rcId=${activeRcId}&isDefault=${isDefaultActive}` : ''
        // Food-cost KPIs are week-to-date (Monday → today), matching the cost-chrome
        // strip. fcFrom/fcTo window only the food-cost block — the wastage card stays
        // rolling-7d.
        const now = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const fmtLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        const fcFrom = fmtLocal(startOfWeek(now))
        const fcTo   = fmtLocal(now)
        const fcQs = `${qs ? `${qs}&` : '?'}fcFrom=${fcFrom}&fcTo=${fcTo}`
        const cogsQs = `?startDate=${fcFrom}&endDate=${fcTo}${activeRcId ? `&rcId=${activeRcId}&isDefault=${isDefaultActive}` : ''}`
        const [d, c, k, p, s, a, fv, ie, cg] = await Promise.all([
          fetch(`/api/reports/dashboard${fcQs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/insights/cost-chrome${activeRcId ? `?rcId=${activeRcId}` : ''}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/invoices/kpis${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch('/api/prep/items', { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
          fetch('/api/count/sessions', { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
          fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : { priceAlerts: [] }),
          fetch('/api/insights/food-cost-variance', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch('/api/reports/inventory-efficiency?days=30', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/reports/cogs${cogsQs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
        ])
        if (cancelled) return
        if (d) setDashboard(d)
        if (c) setChrome(c)
        if (k) setInboxKpis(k)
        if (Array.isArray(p)) setPrepItems(p)
        if (Array.isArray(s)) setCountSessions(s)
        if (a?.priceAlerts) setPriceAlertCount(a.priceAlerts.length)
        if (fv) setFcVariance(fv)
        if (ie) setInvEff(ie)
        setCogs(cg ?? null)
      } catch { /* swallow */ }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [activeRcId, isDefaultActive])

  // ── Attention queue (derived) ────────────────────────────────────────────
  const attn = useMemo<AttnItem[]>(() => {
    const items: AttnItem[] = []
    if (priceAlertCount > 0) {
      items.push({
        id: 'price-alerts',
        kind: 'price',
        icon: AlertTriangle,
        iconTint: 'red',
        title: <><b>{priceAlertCount}</b> active price {priceAlertCount === 1 ? 'alert' : 'alerts'} — review impact on recipes</>,
        meta: 'PRICE ALERTS · open Inbox to acknowledge',
        cost: { value: priceAlertCount.toString(), sub: priceAlertCount === 1 ? 'alert' : 'alerts', tint: 'bad' },
        ctaHref: '/invoices',
        ctaLabel: 'Review',
      })
    }
    if (inboxKpis && inboxKpis.awaitingApprovalCount > 0) {
      items.push({
        id: 'invoices-pending',
        kind: 'invoice',
        icon: Mail,
        iconTint: 'amber',
        title: <><b>{inboxKpis.awaitingApprovalCount}</b> {inboxKpis.awaitingApprovalCount === 1 ? 'invoice' : 'invoices'} awaiting approval</>,
        meta: 'OCR · ready for review',
        cost: { value: inboxKpis.awaitingApprovalCount.toString(), sub: 'to approve', tint: 'warn' },
        ctaHref: '/invoices',
        ctaLabel: 'Open',
      })
    }
    const criticalPrep = prepItems.filter(p => p.priority === '911').length
    if (criticalPrep > 0) {
      items.push({
        id: 'prep-critical',
        kind: 'count',
        icon: ClipboardList,
        iconTint: 'red',
        title: <><b>{criticalPrep}</b> critical prep {criticalPrep === 1 ? 'item' : 'items'} — depleted or empty</>,
        meta: 'PREP · build before service',
        cost: { value: criticalPrep.toString(), sub: 'critical', tint: 'bad' },
        ctaHref: '/prep',
        ctaLabel: 'Open prep',
      })
    }
    const latestCount = countSessions
      .filter(s => s.status === 'FINALIZED' && s.finalizedAt)
      .sort((a, b) => new Date(b.finalizedAt!).getTime() - new Date(a.finalizedAt!).getTime())[0]
    const daysSinceCount = latestCount
      ? Math.floor((Date.now() - new Date(latestCount.finalizedAt!).getTime()) / 86_400_000)
      : null
    if (daysSinceCount !== null && daysSinceCount > 4) {
      items.push({
        id: 'count-overdue',
        kind: 'variance',
        icon: Activity,
        iconTint: 'amber',
        title: <>Last count was <b>{daysSinceCount}d ago</b> — theoretical-vs-actual drift widens</>,
        meta: 'COUNT · schedule a partial before brunch',
        cost: { value: `${daysSinceCount}d`, sub: 'stale', tint: 'warn' },
        ctaHref: '/count',
        ctaLabel: 'Schedule',
      })
    }
    return items
  }, [priceAlertCount, inboxKpis, prepItems, countSessions])

  const prepSummary = useMemo(() => {
    const active = prepItems.filter(p => p.onHand >= 0 || p.priority !== 'LATER')
    const top = [...prepItems]
      .filter(p => p.priority !== 'LATER')
      .sort((a, b) => (a.priority === '911' ? -1 : 0) - (b.priority === '911' ? -1 : 0))
      .slice(0, 5)
    return { total: active.length, top }
  }, [prepItems])

  const greeting = greetingFor(new Date())
  const firstName = user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'there'

  const cutoff = nextServiceCutoff(new Date())
  const remainingMs = cutoff.getTime() - Date.now()
  const remainingH = Math.floor(remainingMs / 3_600_000)
  const remainingM = Math.floor((remainingMs % 3_600_000) / 60_000)

  return (
    <>
      <SubNav
        tabs={[
          { href: '/pass', label: 'Pass' },
          { href: '/preshift', label: 'Pre-shift', icon: <Activity size={14} /> },
          { href: '/reports', label: 'End-of-day', icon: <Clock size={14} /> },
        ]}
      />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">

        <PageHead
          crumbs={<><Clock size={12} /> TODAY / PASS · {fmtCrumbDate(new Date())}</>}
          title={<>Good {greeting}, <em className="font-fraunces italic font-medium text-gold-2">{firstName}</em>.</>}
          sub={<>
            {greeting === 'morning' ? 'Dinner' : 'Tomorrow'} service in <b>{remainingH}h {remainingM}m</b>
            {dashboard && <> · weekly food sales <b>{formatCurrency(dashboard.weeklyRevenue)}</b></>}
            {attn.length > 0 && <> · <b className="text-red-text">{attn.length} {attn.length === 1 ? 'thing' : 'things'}</b> need you</>}
          </>}
          actions={
            <>
              <Link href="/reports" className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
                <Clock size={13} className="text-ink-3" /> End-of-day
              </Link>
              <Link href="/preshift" className="inline-flex items-center gap-1.5 bg-ink text-paper px-4 py-[9px] rounded-[9px] text-[13px] font-medium hover:bg-[#18181b] transition-colors">
                <ArrowRight size={13} className="text-gold" /> Start pre-shift
              </Link>
            </>
          }
        />

        <div className="grid gap-3 mb-6 grid-cols-2 lg:grid-cols-3">
          <FoodCostHero
            label="PURCHASE COST · WTD" sub="invoices ÷ food sales"
            pct={dashboard?.purchaseFoodCostPct ?? chrome?.foodCostPct ?? null}
            target={chrome?.targetPct ?? 27}
          />
          <FoodCostHero
            label={`ACTUAL ${costNoun} · WTD`} sub="COGS ÷ food sales"
            pct={cogs?.actualFoodCostPct ?? null}
            target={chrome?.targetPct ?? 27}
            title={
              cogs && cogs.actualFoodCostPct != null
                ? cogs.rcCoverage
                  ? cogs.rcCoverage.uncounted.length > 0
                    ? `Sum of all ${cogs.rcCoverage.total} revenue centers. Uncounted (purchases-only this period): ${cogs.rcCoverage.uncounted.join(', ')}.`
                    : `Sum of all ${cogs.rcCoverage.total} revenue centers, each bracketed by its own full counts.`
                  : cogs.beginningInventory?.needsCount
                    ? 'No opening full count for this period — run one to bracket COGS.'
                    : (cogs.endingInventory?.needsCount || cogs.endingInventory?.sameAsOpening)
                      ? `Opening count ${fmtCountDate(cogs.beginningInventory?.sessionDate)} · no closing full count yet — COGS = opening + purchases. Run a full count to close the period.`
                      : `COGS bracketed by full counts: ${fmtCountDate(cogs.beginningInventory?.sessionDate)} → ${fmtCountDate(cogs.endingInventory?.sessionDate)}`
                : undefined
            }
            footer={
              cogs && cogs.actualFoodCostPct != null ? (
                <>
                  {cogs.foodCostVariancePts != null ? (
                    <>
                      <span className={cogs.foodCostVariancePts > 0 ? 'text-red' : 'text-green'}>
                        {cogs.foodCostVariancePts > 0 ? '+' : ''}{cogs.foodCostVariancePts.toFixed(1)} pts
                      </span>{' '}vs theoretical{' '}
                      <b className="text-paper">{cogs.theoreticalFoodCostPct != null ? `${cogs.theoreticalFoodCostPct.toFixed(1)}%` : '—'}</b>
                    </>
                  ) : <>vs theoretical n/a</>}
                  {' · '}
                  <span className="text-ink-4">
                    {cogs.rcCoverage
                      ? cogs.rcCoverage.uncounted.length > 0
                        ? `${cogs.rcCoverage.uncounted.length} of ${cogs.rcCoverage.total} RCs uncounted`
                        : `ΣRC · ${cogs.rcCoverage.total} RCs`
                      : cogs.beginningInventory?.needsCount
                        ? 'count needed'
                        : (cogs.endingInventory?.needsCount || cogs.endingInventory?.sameAsOpening)
                          ? `${fmtCountDate(cogs.beginningInventory?.sessionDate)} → now*`
                          : `${fmtCountDate(cogs.beginningInventory?.sessionDate)} → ${fmtCountDate(cogs.endingInventory?.sessionDate)}`}
                  </span>
                </>
              ) : <span className="text-ink-4">needs full count</span>
            }
          />
          <FoodCostHero
            label={`THEORETICAL ${costNoun} · WTD`} sub="from recipe costs"
            pct={dashboard?.theoreticalFoodCostPct ?? null}
            target={chrome?.targetPct ?? 27}
            footer={dashboard ? (
              <>
                {dashboard.costPerCover != null
                  ? <><b className="text-paper">{formatCurrency(dashboard.costPerCover)}</b>/cover</>
                  : <>per-cover n/a</>}
                {' · '}
                <span className="text-ink-4">
                  {dashboard.theoreticalCoverage.costed}/{dashboard.theoreticalCoverage.total} items costed
                </span>
              </>
            ) : undefined}
          />
          <KPI label="THEORETICAL ON HAND"
            value={dashboard ? formatCurrency(dashboard.totalInventoryValue) : '—'}
            delta={invEff?.daysOnHand != null
              ? <><b>{invEff.daysOnHand.toFixed(0)}</b> days on hand · <b>{dashboard?.outOfStockCount ?? 0}</b> out of stock</>
              : <><b>{dashboard?.outOfStockCount ?? 0}</b> out of stock</>}
          />
          <KPI label="PREP TO DO"
            value={prepSummary.total.toString()}
            delta={
              prepSummary.top.filter(p => p.priority === '911').length > 0
                ? <><b className="text-red-text">{prepSummary.top.filter(p => p.priority === '911').length} critical</b></>
                : <>all on par</>
            }
          />
          <KPI label="WASTAGE · 7D"
            value={dashboard ? formatCurrency(dashboard.weeklyWastageCost) : '—'}
            valueClass={dashboard && dashboard.weeklyWastageCost > 0 ? 'text-red-text' : ''}
            delta={dashboard?.wastagePctOfSales != null
              ? <><b className={dashboard.wastagePctOfSales > 3 ? 'text-red-text' : ''}>{dashboard.wastagePctOfSales.toFixed(1)}%</b> of food sales</>
              : <>tracked from <b>waste log</b></>}
          />
        </div>

        {fcVariance && !fcVariance.needsCounts && fcVariance.variancePctPoints != null && (
          <div className="mb-6 -mt-3 flex items-center gap-3 font-mono text-[11px] text-ink-3">
            <span className="w-1.5 h-1.5 rounded-full bg-gold" />
            <span>
              SHRINKAGE · last count period —
              actual <b className="text-ink">{fcVariance.actualFoodCostPct!.toFixed(1)}%</b> vs
              theoretical <b className="text-ink">{fcVariance.theoreticalFoodCostPct!.toFixed(1)}%</b> ·
              drift <b className={fcVariance.variancePctPoints > 0 ? 'text-red-text' : 'text-green'}>
                {fcVariance.variancePctPoints > 0 ? '+' : ''}{fcVariance.variancePctPoints.toFixed(1)} pts
              </b>
              {fcVariance.varianceDollars != null && <> ({formatCurrency(fcVariance.varianceDollars)})</>}
            </span>
            <span className="text-ink-4">global only</span>
          </div>
        )}

        <div className="grid gap-5 grid-cols-1 lg:grid-cols-[1fr_320px]">
          <div className="space-y-5 min-w-0">

            <section className="bg-paper border border-line rounded-[12px] overflow-hidden">
              <header className="flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2">
                <h3 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${attn.length > 0 ? 'bg-red' : 'bg-green'}`} />
                  Needs you <span className="font-mono text-[10.5px] text-ink-3 font-normal">· {attn.length} {attn.length === 1 ? 'item' : 'items'}</span>
                </h3>
                <span className="font-mono text-[10.5px] text-ink-3">SORTED BY $ IMPACT</span>
              </header>
              {attn.length === 0 ? (
                <div className="px-6 py-10 text-center">
                  <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
                  <p className="text-[13px] text-ink-3 mt-1.5">Nothing needs you right now — go cook.</p>
                </div>
              ) : attn.map(a => (
                <AttnRow key={a.id} item={a} />
              ))}
            </section>

            <div className="grid grid-cols-2 gap-4">
              <PrepCard items={prepSummary.top} />
              <CountCard sessions={countSessions} />
            </div>

            <LoopStrip phase={loopPhase(new Date())} weeklyRevenue={dashboard?.weeklyRevenue} />
          </div>

          <aside className="space-y-3.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Right rail · context</div>

            <RailCard icon={<Zap size={11} />} iconTint="amber" title="Signal of the day">
              {priceAlertCount > 0 ? (
                <>You have <b>{priceAlertCount}</b> active price {priceAlertCount === 1 ? 'alert' : 'alerts'} — review whether to bump menu prices or switch suppliers before lunch service.</>
              ) : (
                <>No new signals. Your spine is clean — the live cost chrome above is up to date.</>
              )}
              <div className="flex gap-2 mt-3">
                <Link href="/signals" className="inline-flex items-center gap-1 border border-line bg-paper text-ink-2 px-3 py-1.5 rounded-[7px] text-[12px] font-medium hover:border-ink-3 transition-colors">
                  Open signals
                </Link>
              </div>
            </RailCard>

            <RailCard icon={<Activity size={11} />} iconTint="blue" title="Loop says…">
              {(() => {
                const latest = countSessions.filter(s => s.status === 'FINALIZED' && s.finalizedAt)[0]
                if (!latest) return <>No counts yet. Schedule your first count to start closing the loop.</>
                const days = Math.floor((Date.now() - new Date(latest.finalizedAt!).getTime()) / 86_400_000)
                return <>Counts are <b>{days}d old</b>. Theoretical-vs-actual drift widens until the next reconciliation. Schedule a partial count before service.</>
              })()}
              <div className="flex gap-2 mt-3">
                <Link href="/count" className="inline-flex items-center gap-1 bg-ink text-paper px-3 py-1.5 rounded-[7px] text-[12px] font-medium hover:bg-[#18181b] transition-colors">
                  Schedule count
                </Link>
              </div>
            </RailCard>
          </aside>
        </div>

        <div className="mt-4 flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide">
          <span>PASS REFRESHES EVERY 60S</span>
          <span><kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘R</kbd> REFRESH · <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘/</kbd> SEARCH</span>
        </div>
      </div>
    </>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

// sessionDate is stored at UTC midnight — format in UTC so the calendar day doesn't shift.
const fmtCountDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null

function FoodCostHero({ label, sub, pct, target, footer, title }: {
  label: string; sub: string; pct: number | null; target: number; footer?: React.ReactNode; title?: string
}) {
  const t = Number(target)
  const formatted = pct !== null ? pct.toFixed(1) : null
  const intStr = formatted !== null ? formatted.split('.')[0] : '—'
  const decimal = formatted !== null ? `.${formatted.split('.')[1]}%` : ''
  return (
    <div title={title} className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px] relative overflow-hidden">
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">{label}</div>
        <div className="font-mono text-[9px] text-ink-4 tracking-[0.01em] mt-0.5">{sub}</div>
        <div className="text-[44px] font-semibold tracking-[-0.045em] leading-none mt-2">
          {intStr}<sub className="text-[20px] font-medium text-gold tracking-[-0.02em] align-baseline">{decimal}</sub>
        </div>
      </div>
      <div className="font-mono text-[11px] text-ink-3 tracking-[0]">
        {footer ?? (
          <>target <b className="text-paper">{t.toFixed(1)}</b>
            {pct !== null && (
              <> · <span className={pct > t ? 'text-red' : 'text-green'}>
                {pct > t ? '+' : ''}{(pct - t).toFixed(1)}
              </span> vs target</>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function KPI({ label, value, delta, valueClass = '' }: { label: string; value: string; delta: React.ReactNode; valueClass?: string }) {
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

function AttnRow({ item }: { item: AttnItem }) {
  const tint = {
    red:   'bg-red-soft text-red-text',
    amber: 'bg-gold-soft text-gold-2',
    blue:  'bg-blue-soft text-blue-text',
    green: 'bg-green-soft text-green-text',
  }[item.iconTint]
  const costTint = item.cost.tint === 'bad' ? 'text-red-text'
    : item.cost.tint === 'warn' ? 'text-gold-2'
    : item.cost.tint === 'ok' ? 'text-green-text' : ''
  const Icon = item.icon
  return (
    <Link href={item.ctaHref} className="grid grid-cols-[48px_minmax(0,1fr)_auto_auto] items-center gap-3.5 px-[18px] py-3.5 border-b border-line last:border-0 cursor-pointer hover:bg-bg-2/40 transition-colors">
      <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${tint}`}>
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <div className="text-[14px] font-medium tracking-[-0.01em] text-ink [&_b]:font-semibold [&_b]:text-red-text">{item.title}</div>
        <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0]">{item.meta}</div>
      </div>
      <div className={`text-right font-mono text-[13.5px] font-semibold tracking-[-0.01em] ${costTint}`}>
        {item.cost.value}
        <small className="block font-normal text-ink-3 font-mono text-[10.5px] mt-0.5">{item.cost.sub}</small>
      </div>
      <button className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-ink text-paper font-medium hover:bg-ink-2 transition-colors">
        {item.ctaLabel}
      </button>
    </Link>
  )
}

function PrepCard({ items }: { items: PrepItem[] }) {
  return (
    <div className="bg-paper border border-line rounded-[12px] p-5">
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-[15px] font-semibold tracking-[-0.015em]">
          Today&apos;s prep <span className="font-mono text-[10.5px] text-ink-3 font-normal">· {items.length} {items.length === 1 ? 'card' : 'cards'}</span>
        </h3>
        <Link href="/prep" className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current">Open prep →</Link>
      </header>
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-3 py-4 text-center">No prep needed today.</p>
      ) : items.map(it => {
        const pct = it.parLevel > 0 ? Math.min(100, (it.onHand / it.parLevel) * 100) : 100
        const tone = it.priority === '911' ? 'bad' : it.priority === 'NEEDED_TODAY' ? 'warn' : 'ok'
        return (
          <div key={it.id} className="grid grid-cols-[1fr_64px_auto] items-center gap-2.5 py-2 border-b border-dashed border-line last:border-0 text-[13px]">
            <div className="font-medium text-ink tracking-[-0.005em] truncate">{it.name}</div>
            <div className="h-[5px] rounded-full bg-bg-2 overflow-hidden">
              <div className={`h-full rounded-full ${tone === 'bad' ? 'bg-red' : tone === 'warn' ? 'bg-gold' : 'bg-green'}`} style={{ width: `${pct}%` }} />
            </div>
            <div className={`font-mono text-[11px] tracking-[0] tabular-nums whitespace-nowrap ${tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-ink-3'}`}>
              {it.onHand.toFixed(it.onHand % 1 === 0 ? 0 : 1)} / {it.parLevel.toFixed(it.parLevel % 1 === 0 ? 0 : 1)} {it.unit}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CountCard({ sessions }: { sessions: CountSession[] }) {
  const recent = [...sessions]
    .filter(s => s.status === 'FINALIZED' || s.status === 'IN_PROGRESS')
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 4)
  return (
    <div className="bg-paper border border-line rounded-[12px] p-5">
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-[15px] font-semibold tracking-[-0.015em]">
          Counts <span className="font-mono text-[10.5px] text-ink-3 font-normal">· recent activity</span>
        </h3>
        <Link href="/count" className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current">Schedule count →</Link>
      </header>
      {recent.length === 0 ? (
        <p className="text-[13px] text-ink-3 py-4 text-center">No counts yet. Start one →</p>
      ) : recent.map(s => {
        const ref = new Date(s.finalizedAt ?? s.startedAt)
        const days = Math.floor((Date.now() - ref.getTime()) / 86_400_000)
        const tone = days > 4 ? 'bad' : days > 2 ? 'warn' : 'ok'
        return (
          <div key={s.id} className="grid grid-cols-[1fr_auto] items-center gap-2 py-2 border-b border-dashed border-line last:border-0 text-[13px]">
            <div className="min-w-0">
              <div className="font-medium text-ink tracking-[-0.005em] truncate">{s.label || 'Count'}</div>
              <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">{s.countedBy} · {s.status === 'IN_PROGRESS' ? 'in progress' : days === 0 ? 'today' : `${days}d ago`}</div>
            </div>
            <div className={`font-mono text-[11px] tracking-[0] whitespace-nowrap ${tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-green-text'}`}>
              {s.status === 'IN_PROGRESS' ? 'active' : 'finalized'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LoopStrip({ phase, weeklyRevenue }: { phase: number; weeklyRevenue?: number }) {
  const labels = ['01 IN','02 HOLD','03 BUILD','04 PLAN','05 MOVE','06 TRUTH']
  return (
    <div className="bg-ink text-paper rounded-[12px] px-5 py-4 flex items-center gap-5 flex-wrap">
      <span className="font-mono text-[10.5px] text-gold uppercase tracking-[0.04em] font-semibold whitespace-nowrap">↻ THE LOOP</span>
      <div className="text-[12.5px] text-line-2 tracking-[-0.005em] flex-1 min-w-[300px] [&_b]:text-paper [&_b]:font-medium">
        You&apos;re at <b>{labels[phase]}</b> — overnight invoices write prices, prep starts, sales drain theoretical, counts close the loop weekly.
        {typeof weeklyRevenue === 'number' && weeklyRevenue > 0 && <> WTD revenue: <b>{formatCurrency(weeklyRevenue)}</b>.</>}
      </div>
      <div className="hidden xl:flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
        {labels.map((label, i) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className={`px-2.5 py-1 border rounded-full ${i === phase ? 'bg-gold text-ink border-gold font-semibold' : 'border-ink-2 text-ink-3'}`}>{label}</span>
            {i < labels.length - 1 && <span className="text-ink-2">→</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

function RailCard({ icon, iconTint, title, children }: {
  icon: React.ReactNode; iconTint: 'amber' | 'blue' | 'neutral'; title: string; children: React.ReactNode
}) {
  const iconCls = iconTint === 'amber' ? 'bg-gold-soft text-gold-2'
    : iconTint === 'blue' ? 'bg-blue-soft text-blue-text'
    : 'bg-bg-2 text-ink-3'
  return (
    <div className="bg-paper border border-line rounded-[12px] p-4">
      <h4 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2 mb-2">
        <span className={`w-5 h-5 rounded-md grid place-items-center ${iconCls}`}>{icon}</span>
        {title}
      </h4>
      <div className="text-[13px] leading-[1.5] text-ink-2 tracking-[-0.005em] [&_b]:text-ink [&_b]:font-semibold">
        {children}
      </div>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function greetingFor(d: Date): 'morning' | 'afternoon' | 'evening' {
  const h = d.getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

function nextServiceCutoff(d: Date): Date {
  const cutoff = new Date(d)
  if (d.getHours() < 17) {
    cutoff.setHours(17, 0, 0, 0)
  } else {
    cutoff.setDate(d.getDate() + 1)
    cutoff.setHours(11, 0, 0, 0)
  }
  return cutoff
}

function fmtCrumbDate(d: Date): string {
  return d.toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase()
}

function loopPhase(d: Date): number {
  const h = d.getHours()
  if (h < 6) return 0   // IN — overnight
  if (h < 9) return 1   // HOLD
  if (h < 12) return 2  // BUILD
  if (h < 15) return 3  // PLAN
  if (h < 21) return 4  // MOVE
  return 5              // TRUTH
}
