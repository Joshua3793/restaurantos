'use client'
import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Mail, Activity, Zap, Clock,
  ArrowRight, ClipboardList, Truck, Moon, Check, RefreshCw,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { getVocab } from '@/lib/rc-vocab'
import { useUser } from '@/contexts/UserContext'
import { formatCurrency } from '@/lib/utils'
import { startOfWeek } from '@/lib/dates'
import { serviceStatus, formatServiceStatus, type RcService } from '@/lib/service-hours'
import { setScopeParams } from '@/lib/scope-params'
import { useNowMinute } from '@/components/prep/runsheet/useNowMinute'
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

// The last close, read on the next morning's Pass — the "From last night's
// close" band. `snapshot` holds the reconciled numbers written at sign-off.
interface LastClose {
  handoverNote: string | null
  signedOffByName: string | null
  signedOffAt: string | null
  businessDate: string
  snapshot: {
    netSales?: number | null
    covers?: number | null
    foodCostPct?: number | null
    foodCostDollars?: number | null
  } | null
}

// Below-par order suggestions grouped by supplier (GET /api/eod/orders).
interface OrderSuggestions {
  suppliers: Array<{ supplierName: string; subtotal: number; lines: unknown[] }>
  lineCount: number
  total: number
}

interface BandTile {
  key: string
  dot: string
  label: string
  value: React.ReactNode
  unit: string
  meta: React.ReactNode
  href: string
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
  const { user, role } = useUser()
  const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()
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
  const [lastClose, setLastClose] = useState<LastClose | null>(null)
  const [orders, setOrders] = useState<OrderSuggestions | null>(null)
  const [bandDismissed, setBandDismissed] = useState(false)
  const [syncingSales, setSyncingSales] = useState(false)
  const [syncNote, setSyncNote] = useState<{ ok: boolean; text: string } | null>(null)
  // Bumped after a manual sales sync to force the dashboard to refetch.
  const [reloadTick, setReloadTick] = useState(0)

  // Last night's close + below-par order drafts — the loop handoff. Both are
  // per-RC (par/reorder live on the RC's StockAllocation; the close is per-RC),
  // so they only load when scoped to a single revenue center.
  useEffect(() => {
    let cancelled = false
    if (activeKind !== 'rc' || !activeRcId) {
      setLastClose(null)
      setOrders(null)
      return
    }
    fetch(`/api/eod/handover?rcId=${activeRcId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(json => { if (!cancelled) setLastClose(json) })
      .catch(() => { if (!cancelled) setLastClose(null) })
    fetch(`/api/eod/orders?rcId=${activeRcId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(json => { if (!cancelled) setOrders(json) })
      .catch(() => { if (!cancelled) setOrders(null) })
    return () => { cancelled = true }
  }, [activeKind, activeRcId])

  // "Acknowledge" collapses the band for this close (persisted per business date
  // so it doesn't reappear on refresh, but returns the morning after the next close).
  useEffect(() => {
    if (!lastClose) { setBandDismissed(false); return }
    try {
      const key = `pass:band-ack:${activeRcId}:${lastClose.businessDate}`
      setBandDismissed(localStorage.getItem(key) === '1')
    } catch { setBandDismissed(false) }
  }, [lastClose, activeRcId])

  const dismissBand = () => {
    setBandDismissed(true)
    try {
      if (lastClose) localStorage.setItem(`pass:band-ack:${activeRcId}:${lastClose.businessDate}`, '1')
    } catch { /* ignore */ }
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const scope = new URLSearchParams()
        setScopeParams(scope, { activeKind, activeRcId, activeRc, activeLocationId })
        const qs = scope.toString() ? `?${scope.toString()}` : ''
        // Food-cost KPIs are week-to-date (Monday → today), matching the cost-chrome
        // strip. fcFrom/fcTo window only the food-cost block — the wastage card stays
        // rolling-7d.
        const now = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const fmtLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        const fcFrom = fmtLocal(startOfWeek(now))
        const fcTo   = fmtLocal(now)
        const fcParams = new URLSearchParams(scope)
        fcParams.set('fcFrom', fcFrom); fcParams.set('fcTo', fcTo)
        const fcQs = `?${fcParams.toString()}`
        const cogsParams = new URLSearchParams(scope)
        cogsParams.set('startDate', fcFrom); cogsParams.set('endDate', fcTo)
        const cogsQs = `?${cogsParams.toString()}`
        // Days-on-hand shares the same scope as the on-hand $ card it sits under.
        const effParams = new URLSearchParams(scope)
        effParams.set('days', '30')
        const effQs = `?${effParams.toString()}`
        const [d, c, k, p, s, a, fv, ie, cg] = await Promise.all([
          fetch(`/api/reports/dashboard${fcQs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/insights/cost-chrome${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/invoices/kpis${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/prep/items${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
          fetch(`/api/count/sessions${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
          fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : { priceAlerts: [] }),
          fetch('/api/insights/food-cost-variance', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/reports/inventory-efficiency${effQs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
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
  }, [activeRcId, activeRc, activeKind, activeLocationId, reloadTick])

  // ── Attention queue (derived) ────────────────────────────────────────────
  const attn = useMemo<AttnItem[]>(() => {
    const items: AttnItem[] = []
    // From the close: below-par items grouped by supplier → send-ready order drafts.
    // Leads the queue when present — it carries the largest dollar figure.
    if (orders && orders.lineCount > 0) {
      const supN = orders.suppliers.length
      items.push({
        id: 'order-drafts',
        kind: 'invoice',
        icon: Truck,
        iconTint: 'blue',
        title: <><b>{orders.lineCount}</b> {orders.lineCount === 1 ? 'item' : 'items'} below par — order draft ready across {supN} {supN === 1 ? 'supplier' : 'suppliers'}</>,
        meta: `FROM CLOSE · ${orders.suppliers.map(s => s.supplierName).slice(0, 3).join(' · ')}`,
        cost: { value: formatCurrency(orders.total), sub: supN === 1 ? '1 supplier' : `${supN} suppliers`, tint: 'warn' },
        ctaHref: '/inventory',
        ctaLabel: 'Review & order',
      })
    }
    if (priceAlertCount > 0) {
      items.push({
        id: 'price-alerts',
        kind: 'price',
        icon: AlertTriangle,
        iconTint: 'red',
        title: <><b>{priceAlertCount}</b> active price {priceAlertCount === 1 ? 'alert' : 'alerts'} — review impact on recipes</>,
        meta: 'PRICE ALERTS · all RCs · open Inbox to acknowledge',
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
  }, [orders, priceAlertCount, inboxKpis, prepItems, countSessions])

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

  // Service status from the active RC's real schedule — the SAME serviceStatus()
  // the prep header and run sheet use, so this can't disagree with them anymore.
  // Null for all/location scope (no single RC to report on).
  //
  // `nowMin` comes from useNowMinute() (the hook /prep uses) and IS a dependency:
  // computing the clock inside the memo froze this clause at mount, so /pass
  // still read "Brunch in 30m" long after /prep had moved on to "underway".
  const { nowMin } = useNowMinute()
  const serviceClause = useMemo<React.ReactNode>(() => {
    if (activeKind !== 'rc' || !activeRc) return null
    const status = serviceStatus((activeRc.services ?? []) as RcService[], nowMin, activeRc.prepLeadMinutes ?? null)
    // The text itself always comes from service-hours.ts's formatServiceStatus — the
    // single rendering every surface shares. This chain only decides the JSX shape
    // ("closed" renders nothing) and, via the exhaustiveness guard below, makes a
    // future ServiceStatus member a compile error here instead of a silent "on-demand".
    if (status.kind === 'upcoming' || status.kind === 'underway' || status.kind === 'closed' || status.kind === 'none') {
      const formatted = formatServiceStatus(status)
      if (!formatted) return null
      return <><b>{formatted.lead}</b>{formatted.trail && <> · <b>{formatted.trail}</b></>}</>
    }
    const _never: never = status
    return _never
  }, [activeKind, activeRc, nowMin])

  // ── Loop handoff: reconciled "yesterday" + carries from the close ──────────
  const snap = lastClose?.snapshot ?? null
  const hasReconciled = !!snap && (snap.netSales != null || snap.covers != null || snap.foodCostPct != null)
  const closeTime = lastClose?.signedOffAt
    ? new Date(lastClose.signedOffAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : null
  const criticalPrep = prepItems.filter(p => p.priority === '911').length
  const latestFinalizedCount = countSessions
    .filter(s => s.status === 'FINALIZED' && s.finalizedAt)
    .sort((a, b) => new Date(b.finalizedAt!).getTime() - new Date(a.finalizedAt!).getTime())[0]
  const countDays = latestFinalizedCount
    ? Math.floor((Date.now() - new Date(latestFinalizedCount.finalizedAt!).getTime()) / 86_400_000)
    : null
  // Carries = handoff buckets that still need a look this morning.
  const carryCount =
    (criticalPrep > 0 ? 1 : 0) +
    (orders && orders.lineCount > 0 ? 1 : 0) +
    (countDays != null && countDays > 4 ? 1 : 0)
  const showBand = !!lastClose && !bandDismissed && (hasReconciled || !!lastClose.handoverNote?.trim() || carryCount > 0)

  // On-demand Toast sales pull for today (MANAGER+). Idempotent server-side, so
  // clicking repeatedly just refreshes the day's figures.
  const syncSales = async () => {
    setSyncingSales(true); setSyncNote(null)
    try {
      const res = await fetch('/api/toast/sync-sales', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSyncNote({ ok: false, text: data.error || 'Sync failed' })
      } else {
        const r = data.result
        const revenue = (r?.perRc ?? []).reduce((s: number, x: { totalRevenue: number }) => s + x.totalRevenue, 0)
        setSyncNote(
          r?.status === 'error'
            ? { ok: false, text: r.error || 'Sync failed' }
            : r?.status === 'skipped' || (r?.ordersPulled ?? 0) === 0
              ? { ok: true, text: 'No sales yet today' }
              : { ok: true, text: `Synced ${r.ordersPulled} ${r.ordersPulled === 1 ? 'order' : 'orders'} · ${formatCurrency(revenue)}` },
        )
        setReloadTick(t => t + 1) // pull the refreshed figures into the dashboard
      }
    } catch {
      setSyncNote({ ok: false, text: 'Request failed' })
    } finally {
      setSyncingSales(false)
      setTimeout(() => setSyncNote(null), 6000)
    }
  }

  return (
    <>
      <SubNav
        tabs={[
          { href: '/pass', label: 'Pass' },
          { href: '/preshift', label: 'Pre-shift', icon: <Activity size={14} /> },
          { href: '/end-of-day', label: 'End-of-day', icon: <Clock size={14} /> },
        ]}
      />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">

        <PageHead
          crumbs={<><Clock size={12} /> TODAY / PASS · {fmtCrumbDate(new Date())}</>}
          title={<>Good {greeting}, <em className="font-fraunces italic font-medium text-gold-2">{firstName}</em>.</>}
          sub={hasReconciled ? <>
            Yesterday closed{snap!.covers != null && <> at <b>{snap!.covers} covers</b></>}
            {snap!.netSales != null && <> · <b>{formatCurrency(snap!.netSales)}</b> net</>}
            {snap!.foodCostPct != null && <> · food cost <b className={snap!.foodCostPct > (chrome?.targetPct ?? 27) ? 'text-red-text' : 'text-green-text'}>{snap!.foodCostPct.toFixed(1)}%</b></>}
            {closeTime && <> — closed <b>{closeTime}</b>{lastClose!.signedOffByName && <> by {lastClose!.signedOffByName}</>}</>}
            {serviceClause && <>. {serviceClause}</>}
            {carryCount > 0 && <> · <b className="text-gold-2">{carryCount} {carryCount === 1 ? 'carry' : 'carries'}</b> from the close</>}
          </> : <>
            {serviceClause}
            {dashboard && <>{serviceClause && <> · </>}weekly food sales <b>{formatCurrency(dashboard.weeklyRevenue)}</b></>}
            {attn.length > 0 && <> · <b className="text-red-text">{attn.length} {attn.length === 1 ? 'thing' : 'things'}</b> need you</>}
          </>}
          actions={
            <>
              {(role === 'ADMIN' || role === 'MANAGER') && (
                <div className="inline-flex items-center gap-2">
                  {syncNote && (
                    <span className={`text-[12px] font-medium ${syncNote.ok ? 'text-ink-3' : 'text-red-text'}`}>
                      {syncNote.text}
                    </span>
                  )}
                  <button
                    onClick={syncSales}
                    disabled={syncingSales}
                    title="Pull today's sales from Toast now"
                    className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-60"
                  >
                    <RefreshCw size={13} className={`text-ink-3 ${syncingSales ? 'animate-spin' : ''}`} />
                    {syncingSales ? 'Syncing…' : 'Sync sales'}
                  </button>
                </div>
              )}
              <Link href="/end-of-day" className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
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

            {showBand && (
              <LastCloseBand
                lastClose={lastClose!}
                closeTime={closeTime}
                criticalPrep={criticalPrep}
                prepTotal={prepSummary.total}
                orders={orders}
                countDays={countDays}
                countLabel={latestFinalizedCount?.label ?? null}
                onDismiss={dismissBand}
              />
            )}

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
                <>You have <b>{priceAlertCount}</b> active price {priceAlertCount === 1 ? 'alert' : 'alerts'} <span className="text-ink-3">(across all RCs)</span> — review whether to bump menu prices or switch suppliers before lunch service.</>
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

// ── "From last night's close" band ───────────────────────────────────────────
// The loop handoff made physical: Pass opens as the second half of the close.
// Header (who/when) → handover note → tiles that deep-link to where each carry
// gets resolved (Prep, order guide, Count).
function LastCloseBand({
  lastClose, closeTime, criticalPrep, prepTotal, orders, countDays, countLabel, onDismiss,
}: {
  lastClose: LastClose
  closeTime: string | null
  criticalPrep: number
  prepTotal: number
  orders: OrderSuggestions | null
  countDays: number | null
  countLabel: string | null
  onDismiss: () => void
}) {
  const note = lastClose.handoverNote?.trim()
  const tiles: BandTile[] = [
    {
      key: 'prep',
      dot: 'bg-gold',
      label: 'Prep to build',
      value: criticalPrep > 0 ? criticalPrep : prepTotal,
      unit: criticalPrep > 0 ? 'critical' : 'on list',
      meta: criticalPrep > 0
        ? <><b className="text-ink-2">{criticalPrep}</b> depleted or empty — build first</>
        : <>{prepTotal} {prepTotal === 1 ? 'card' : 'cards'} queued today</>,
      href: '/prep',
    },
    {
      key: 'orders',
      dot: 'bg-blue',
      label: 'Order draft',
      value: orders && orders.lineCount > 0 ? orders.suppliers.length : 0,
      unit: orders && orders.suppliers.length === 1 ? 'supplier' : 'suppliers',
      meta: orders && orders.lineCount > 0
        ? <><b className="text-ink-2">{formatCurrency(orders.total)}</b> · {orders.lineCount} {orders.lineCount === 1 ? 'line' : 'lines'} below par</>
        : <>all above par — nothing to order</>,
      href: '/inventory',
    },
    {
      key: 'counts',
      dot: 'bg-green',
      label: 'Counts',
      value: countDays == null ? '—' : countDays === 0 ? 'today' : `${countDays}d`,
      unit: countDays == null ? 'none yet' : 'since last',
      meta: countDays != null && countDays > 4
        ? <><b className="text-red-text">drift widening</b> — count before service</>
        : <>{countLabel ? `${countLabel} · ` : ''}fresh enough</>,
      href: '/count',
    },
  ]

  return (
    <section className="relative bg-paper border border-line rounded-[12px] overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-gold" />
      {/* Header */}
      <header className="flex items-center gap-2.5 pl-5 pr-[18px] py-3 border-b border-line bg-gradient-to-r from-gold-soft to-transparent">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.03em] text-gold-2">
          <Moon size={13} /> From last night&apos;s close
        </span>
        <span className="font-mono text-[10.5px] text-ink-3">
          {closeTime && <>· signed off {closeTime} </>}
          {lastClose.signedOffByName && <>by {lastClose.signedOffByName} </>}
          · {fmtCountDate(lastClose.businessDate)}
        </span>
        <button
          onClick={onDismiss}
          className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-ink-3 border border-line bg-paper rounded-full px-2.5 py-1 hover:text-ink hover:border-ink-3 transition-colors"
        >
          <Check size={11} /> Acknowledge
        </button>
      </header>

      {/* Handover note */}
      {note && (
        <div className="grid grid-cols-[auto_1fr] gap-3 items-start px-5 py-3.5 border-b border-line">
          <div className="w-[26px] h-[26px] rounded-lg bg-ink text-gold grid place-items-center shrink-0">
            <Mail size={14} />
          </div>
          <div className="min-w-0">
            <div className="font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-3 mb-1">Handover note → opener</div>
            <p className="text-[14px] leading-[1.5] text-ink tracking-[-0.005em] font-medium whitespace-pre-wrap">{note}</p>
          </div>
        </div>
      )}

      {/* Tiles */}
      <div className="grid grid-cols-3">
        {tiles.map((t, i) => (
          <Link
            key={t.key}
            href={t.href}
            className={`group relative px-5 py-3.5 hover:bg-bg-2/50 transition-colors ${i < tiles.length - 1 ? 'border-r border-line' : ''}`}
          >
            <div className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.03em] text-ink-3 mb-2">
              <span className={`w-[7px] h-[7px] rounded-full ${t.dot}`} /> {t.label}
            </div>
            <div className="text-[24px] font-semibold tracking-[-0.03em] leading-none">
              {t.value} <span className="text-[13px] font-medium text-ink-3">{t.unit}</span>
            </div>
            <div className="font-mono text-[10px] text-ink-3 mt-1.5 leading-[1.4] [&_b]:font-semibold">{t.meta}</div>
            <ArrowRight size={14} className="absolute right-3.5 top-3.5 text-ink-4 opacity-0 group-hover:opacity-100 transition-opacity" />
          </Link>
        ))}
      </div>
    </section>
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
