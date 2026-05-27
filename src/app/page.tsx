'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { formatCurrency } from '@/lib/utils'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import {
  ArrowRight, FileText, TrendingUp, AlertTriangle,
  ChefHat, Activity, Clock,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DashboardData {
  totalInventoryValue: number
  weeklyWastageCost: number
  outOfStockCount: number
  outOfStockItems: Array<{ id: string; itemName: string; category: string }>
  estimatedFoodCostPct: number
  foodCostLabel: string
}

interface InboxCounts {
  awaitingApprovalCount: number
  priceAlertCount: number
}

interface PrepItem {
  id: string
  name: string
  priority: 'NEEDED_TODAY' | '911' | 'LATER'
  suggestedQty: number
  unit: string
  station: string | null
  onHand: number
  todayLog: object | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function useLiveClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

const PRIORITY_LABEL: Record<PrepItem['priority'], string> = {
  '911': '911',
  NEEDED_TODAY: 'today',
  LATER: 'later',
}
const PRIORITY_COLOR: Record<PrepItem['priority'], string> = {
  '911': 'text-red-600 bg-red-50 border-red-200',
  NEEDED_TODAY: 'text-amber-700 bg-amber-50 border-amber-200',
  LATER: 'text-gray-500 bg-gray-50 border-gray-200',
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PassPage() {
  const now = useLiveClock()
  const { activeRcId, activeRc } = useRc()
  const { user } = useUser()

  const [dash, setDash]   = useState<DashboardData | null>(null)
  const [inbox, setInbox] = useState<InboxCounts | null>(null)
  const [prep, setPrep]   = useState<PrepItem[]>([])
  const [loading, setLoading] = useState(true)

  const firstName = user?.name?.split(' ')[0] ?? null

  const fetchAll = useCallback(async () => {
    const p = new URLSearchParams()
    if (activeRcId) {
      p.set('rcId', activeRcId)
      if (activeRc?.isDefault) p.set('isDefault', 'true')
    }

    const [dashRes, inboxRes, prepRes] = await Promise.allSettled([
      fetch(`/api/reports/dashboard?${p}`).then(r => r.ok ? r.json() : null),
      fetch('/api/invoices/kpis').then(r => r.ok ? r.json() : null),
      fetch('/api/prep/items?active=true').then(r => r.ok ? r.json() : null),
    ])

    if (dashRes.status === 'fulfilled' && dashRes.value && !dashRes.value.error) {
      setDash(dashRes.value)
    }
    if (inboxRes.status === 'fulfilled' && inboxRes.value) {
      setInbox(inboxRes.value)
    }
    if (prepRes.status === 'fulfilled' && Array.isArray(prepRes.value)) {
      setPrep(prepRes.value)
    }
    setLoading(false)
  }, [activeRcId, activeRc])

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 60_000)
    return () => clearInterval(interval)
  }, [fetchAll])

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') fetchAll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchAll])

  // Derived prep metrics
  const urgentPrep = prep.filter(p => p.priority === '911' || p.priority === 'NEEDED_TODAY')
  const prepDue    = urgentPrep.filter(p => !p.todayLog).length
  const previewPrep = prep.filter(p => !p.todayLog).slice(0, 5)

  type AttentionItem = {
    key: string
    icon: React.ComponentType<{ size?: number }>
    label: string
    href: string
    severity: 'warn' | 'info'
  }

  // Attention items
  const attentionItems = ([
    inbox?.awaitingApprovalCount ? {
      key: 'invoices',
      icon: FileText,
      label: `${inbox.awaitingApprovalCount} invoice${inbox.awaitingApprovalCount === 1 ? '' : 's'} pending review`,
      href: '/invoices',
      severity: 'warn' as const,
    } : null,
    inbox?.priceAlertCount ? {
      key: 'prices',
      icon: TrendingUp,
      label: `${inbox.priceAlertCount} price alert${inbox.priceAlertCount === 1 ? '' : 's'} unresolved`,
      href: '/invoices',
      severity: 'warn' as const,
    } : null,
    dash?.outOfStockCount ? {
      key: 'stock',
      icon: AlertTriangle,
      label: `${dash.outOfStockCount} item${dash.outOfStockCount === 1 ? '' : 's'} out of stock`,
      href: '/inventory',
      severity: 'info' as const,
    } : null,
  ] as (AttentionItem | null)[]).filter((x): x is AttentionItem => x !== null)

  const foodCostPct  = dash?.estimatedFoodCostPct ?? 0
  const foodCostHigh = foodCostPct > 35
  const foodCostWarn = foodCostPct > 28 && !foodCostHigh

  const dateStr = now.toLocaleDateString('en-CA', { weekday: 'long', day: 'numeric', month: 'long' })
  const timeStr = now.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })

  // ── Skeleton ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div>
          <div className="h-8 w-64 bg-gray-200 rounded-lg mb-2" />
          <div className="h-4 w-48 bg-gray-100 rounded" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 bg-gray-200 rounded-xl" />
          ))}
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="h-48 bg-gray-200 rounded-xl" />
          <div className="h-48 bg-gray-200 rounded-xl" />
        </div>
      </div>
    )
  }

  // ── Pass ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* ── Header ────────────────────────────────────────────── */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {getGreeting()}{firstName ? `, ${firstName}` : ''}.
          </h1>
          <p className="text-sm text-gray-400 mt-0.5 flex items-center gap-1.5">
            <Clock size={12} />
            {dateStr} · {timeStr}
            {activeRc?.name ? ` · ${activeRc.name}` : ''}
          </p>
        </div>
        <Link
          href="/prep"
          className="hidden sm:flex items-center gap-1.5 text-xs text-gold font-medium hover:underline"
        >
          Open Prep list <ArrowRight size={12} />
        </Link>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">

        {/* Food cost — hero card */}
        <div className="col-span-2 lg:col-span-1 rounded-xl p-4 flex flex-col gap-1"
          style={{ background: '#09090b' }}>
          <p className="text-[10px] font-semibold tracking-widest uppercase"
            style={{ color: 'rgba(255,255,255,0.35)' }}>
            Food Cost · Live
          </p>
          <p className={`text-3xl font-bold tracking-tight ${
            foodCostHigh ? 'text-red-400' : foodCostWarn ? 'text-amber-400' : 'text-gold'
          }`}>
            {foodCostPct > 0 ? `${foodCostPct.toFixed(1)}%` : '—'}
          </p>
          <p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
            {dash?.foodCostLabel ?? 'purchases / food sales'}
          </p>
        </div>

        {/* On hand */}
        <div className="rounded-xl p-4 bg-white border border-gray-100 flex flex-col gap-1">
          <p className="text-[10px] font-semibold tracking-widest uppercase text-gray-400">On Hand</p>
          <p className="text-2xl font-bold text-gray-900 tracking-tight">
            {dash ? formatCurrency(dash.totalInventoryValue) : '—'}
          </p>
          {dash?.outOfStockCount ? (
            <p className="text-[11px] text-amber-600">{dash.outOfStockCount} item{dash.outOfStockCount === 1 ? '' : 's'} out of stock</p>
          ) : (
            <p className="text-[11px] text-gray-400">all items in stock</p>
          )}
        </div>

        {/* Prep due */}
        <div className="rounded-xl p-4 bg-white border border-gray-100 flex flex-col gap-1">
          <p className="text-[10px] font-semibold tracking-widest uppercase text-gray-400">Prep Due</p>
          <p className="text-2xl font-bold text-gray-900 tracking-tight">
            {prep.length > 0 ? prepDue : '—'}
          </p>
          <p className="text-[11px] text-gray-400">
            {prep.length > 0
              ? `of ${prep.length} active item${prep.length === 1 ? '' : 's'}`
              : 'no prep items set up'}
          </p>
        </div>

        {/* Wastage */}
        <div className="rounded-xl p-4 bg-white border border-gray-100 flex flex-col gap-1">
          <p className="text-[10px] font-semibold tracking-widest uppercase text-gray-400">Wastage · 7d</p>
          <p className={`text-2xl font-bold tracking-tight ${
            (dash?.weeklyWastageCost ?? 0) > 500 ? 'text-red-600' : 'text-gray-900'
          }`}>
            {dash ? formatCurrency(dash.weeklyWastageCost) : '—'}
          </p>
          <p className="text-[11px] text-gray-400">this week</p>
        </div>
      </div>

      {/* ── Main panels ───────────────────────────────────────── */}
      <div className="grid md:grid-cols-2 gap-4">

        {/* Needs you */}
        <div className="bg-white rounded-xl border border-gray-100">
          <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900 text-sm">Needs you</h2>
            {attentionItems.length === 0 && (
              <span className="text-[11px] text-green-600 font-medium">All clear ✓</span>
            )}
          </div>

          {attentionItems.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-400 text-sm">
              No pending actions — you&apos;re on top of it.
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {attentionItems.map(item => {
                const Icon = item.icon
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors group"
                  >
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                      item.severity === 'warn'
                        ? 'bg-amber-50 text-amber-500'
                        : 'bg-gray-100 text-gray-400'
                    }`}>
                      <Icon size={14} />
                    </div>
                    <span className="flex-1 text-sm text-gray-700">{item.label}</span>
                    <ArrowRight size={13} className="text-gray-300 group-hover:text-gold transition-colors" />
                  </Link>
                )
              })}
            </div>
          )}

          {/* Out-of-stock list */}
          {dash?.outOfStockItems && dash.outOfStockItems.length > 0 && (
            <div className="px-4 pb-3 pt-1 border-t border-gray-50">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">
                Out of stock
              </p>
              <div className="space-y-1">
                {dash.outOfStockItems.slice(0, 3).map(item => (
                  <Link
                    key={item.id}
                    href={`/inventory?item=${item.id}`}
                    className="flex items-center justify-between text-xs text-gray-600 hover:text-gold transition-colors py-0.5"
                  >
                    <span>{item.itemName}</span>
                    <ArrowRight size={11} className="text-gray-300" />
                  </Link>
                ))}
                {dash.outOfStockItems.length > 3 && (
                  <Link href="/inventory?orderList=1" className="text-xs text-gold hover:underline">
                    +{dash.outOfStockItems.length - 3} more →
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Today's prep preview */}
        <div className="bg-white rounded-xl border border-gray-100">
          <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ChefHat size={15} className="text-gray-400" />
              <h2 className="font-semibold text-gray-900 text-sm">Today&apos;s prep</h2>
            </div>
            <Link href="/prep" className="text-xs text-gold hover:underline flex items-center gap-0.5">
              Full list <ArrowRight size={11} />
            </Link>
          </div>

          {previewPrep.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-400 text-sm">
              {prep.length === 0
                ? 'No prep items set up yet.'
                : 'All prep logged for today — nice work.'}
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {previewPrep.map(item => (
                <Link
                  key={item.id}
                  href="/prep"
                  className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors group"
                >
                  <div className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider ${PRIORITY_COLOR[item.priority]}`}>
                    {PRIORITY_LABEL[item.priority]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{item.name}</p>
                    <p className="text-[11px] text-gray-400">
                      {item.suggestedQty > 0 ? `${item.suggestedQty} ${item.unit}` : item.unit}
                      {item.station ? ` · ${item.station}` : ''}
                    </p>
                  </div>
                  <ArrowRight size={13} className="text-gray-300 group-hover:text-gold transition-colors shrink-0" />
                </Link>
              ))}
              {prep.filter(p => !p.todayLog).length > 5 && (
                <Link
                  href="/prep"
                  className="flex items-center justify-center gap-1 px-4 py-3 text-xs text-gold hover:bg-gold/5 transition-colors"
                >
                  +{prep.filter(p => !p.todayLog).length - 5} more prep items
                  <ArrowRight size={11} />
                </Link>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Quick links ───────────────────────────────────────── */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
        {[
          { href: '/invoices', label: 'Invoices',  icon: FileText },
          { href: '/inventory', label: 'Inventory', icon: AlertTriangle },
          { href: '/recipes',   label: 'Recipes',   icon: ChefHat },
          { href: '/reports',   label: 'Reports',   icon: Activity },
          { href: '/count',     label: 'Count',     icon: Activity },
        ].map(link => {
          const Icon = link.icon
          return (
            <Link
              key={link.href}
              href={link.href}
              className="flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl bg-white border border-gray-100 text-gray-500 hover:border-gold/30 hover:text-gold hover:bg-gold/5 transition-all text-center"
            >
              <Icon size={16} />
              <span className="text-[11px] font-medium">{link.label}</span>
            </Link>
          )
        })}
      </div>

    </div>
  )
}
