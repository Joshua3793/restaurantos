'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { formatCurrency } from '@/lib/utils'
import {
  ArrowRight, TrendingUp, AlertTriangle, ClipboardList,
  ChefHat, RefreshCw, CheckCircle2, Zap,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'

// ── Types ─────────────────────────────────────────────────────────────────────

type Severity = 'high' | 'medium' | 'low'

interface Signal {
  id: string
  severity: Severity
  icon: React.ElementType
  title: string
  body: string
  cta: string
  href: string
}

interface DashboardData {
  estimatedFoodCostPct: number
  outOfStockCount: number
  outOfStockItems: Array<{ id: string; itemName: string }>
  weeklyWastageCost: number
  totalInventoryValue: number
}

interface InboxCounts {
  awaitingApprovalCount: number
  priceAlertCount: number
}

interface Recipe {
  id: string
  name: string
  foodCostPct: number | null
  menuPrice: number | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<Severity, { dot: string; card: string; badge: string }> = {
  high:   { dot: 'bg-red-500',   card: 'border-red-100 bg-red-50/40',    badge: 'text-red-600 bg-red-100' },
  medium: { dot: 'bg-amber-400', card: 'border-amber-100 bg-amber-50/40', badge: 'text-amber-700 bg-amber-100' },
  low:    { dot: 'bg-blue-400',  card: 'border-blue-100 bg-blue-50/40',   badge: 'text-blue-600 bg-blue-100' },
}

const SEVERITY_LABEL: Record<Severity, string> = {
  high:   'Act now',
  medium: 'Review',
  low:    'FYI',
}

function buildSignals(
  dash: DashboardData | null,
  inbox: InboxCounts | null,
  highCostRecipes: Recipe[],
): Signal[] {
  const signals: Signal[] = []

  if (!dash && !inbox) return signals

  // 1 — Unacknowledged price alerts → recipe costs are stale
  if (inbox && inbox.priceAlertCount > 0) {
    signals.push({
      id: 'price-alerts',
      severity: 'high',
      icon: TrendingUp,
      title: `${inbox.priceAlertCount} ingredient price change${inbox.priceAlertCount === 1 ? '' : 's'} unreviewed`,
      body: 'Ingredient costs have changed since your last invoice approval. Recipe food-cost percentages may be out of date until you review and acknowledge these.',
      cta: 'Review price alerts',
      href: '/invoices',
    })
  }

  // 2 — Invoices pending approval
  if (inbox && inbox.awaitingApprovalCount > 0) {
    signals.push({
      id: 'invoices-pending',
      severity: 'medium',
      icon: ArrowRight,
      title: `${inbox.awaitingApprovalCount} invoice${inbox.awaitingApprovalCount === 1 ? '' : 's'} waiting for approval`,
      body: 'Prices won\'t update in your recipes or variance reports until invoices are approved. Approve them to keep your cost data current.',
      cta: 'Go to Inbox',
      href: '/invoices',
    })
  }

  // 3 — High food cost
  if (dash && dash.estimatedFoodCostPct > 32) {
    const label = dash.estimatedFoodCostPct > 40 ? 'critically high' : 'above target'
    signals.push({
      id: 'food-cost-high',
      severity: dash.estimatedFoodCostPct > 40 ? 'high' : 'medium',
      icon: ChefHat,
      title: `Food cost is ${label} at ${dash.estimatedFoodCostPct.toFixed(1)}%`,
      body: `Your target is typically 28–32%. At ${dash.estimatedFoodCostPct.toFixed(1)}%, check for recent price spikes, portion drift, or recipes that need repricing.`,
      cta: 'Review recipe costs',
      href: '/recipes',
    })
  }

  // 4 — High-cost menu recipes
  if (highCostRecipes.length > 0) {
    const top = highCostRecipes[0]
    signals.push({
      id: 'high-cost-recipes',
      severity: 'medium',
      icon: ChefHat,
      title: `${highCostRecipes.length} menu item${highCostRecipes.length === 1 ? '' : 's'} exceed 35% food cost`,
      body: `"${top.name}" is at ${top.foodCostPct?.toFixed(1)}%${top.menuPrice ? ` (selling at ${formatCurrency(top.menuPrice)})` : ''}. Consider a menu price adjustment or finding a lower-cost ingredient substitute.`,
      cta: 'Open menu',
      href: '/menu',
    })
  }

  // 5 — Out of stock items
  if (dash && dash.outOfStockCount > 0) {
    const names = dash.outOfStockItems.slice(0, 2).map(i => i.itemName).join(', ')
    signals.push({
      id: 'out-of-stock',
      severity: 'medium',
      icon: AlertTriangle,
      title: `${dash.outOfStockCount} item${dash.outOfStockCount === 1 ? '' : 's'} out of stock`,
      body: `${names}${dash.outOfStockCount > 2 ? ` and ${dash.outOfStockCount - 2} more` : ''} ${dash.outOfStockCount === 1 ? 'is' : 'are'} at zero. These will block prep recipes that depend on them.`,
      cta: 'View inventory',
      href: '/inventory',
    })
  }

  // 6 — Run a count (always surface if no other critical signals)
  const needsCount = signals.filter(s => s.severity === 'high').length === 0
  if (needsCount) {
    signals.push({
      id: 'schedule-count',
      severity: 'low',
      icon: ClipboardList,
      title: 'Schedule a stock count to close the variance loop',
      body: 'Without a recent count, theoretical vs actual usage can\'t be calculated. A count once or twice a week gives you accurate variance data and surfaces shrinkage early.',
      cta: 'Start a count',
      href: '/count',
    })
  }

  // 7 — High wastage
  if (dash && dash.weeklyWastageCost > 200) {
    signals.push({
      id: 'wastage-high',
      severity: dash.weeklyWastageCost > 500 ? 'medium' : 'low',
      icon: AlertTriangle,
      title: `${formatCurrency(dash.weeklyWastageCost)} wastage logged this week`,
      body: 'Review your wastage log to spot patterns — recurring items often point to over-prepping, short shelf life, or portion inconsistency.',
      cta: 'Review wastage',
      href: '/wastage',
    })
  }

  // Sort: high → medium → low
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
  return signals.sort((a, b) => order[a.severity] - order[b.severity])
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SignalsPage() {
  const { activeRcId, activeRc } = useRc()
  const [dash, setDash]               = useState<DashboardData | null>(null)
  const [inbox, setInbox]             = useState<InboxCounts | null>(null)
  const [highCostRecipes, setHighCost] = useState<Recipe[]>([])
  const [loading, setLoading]         = useState(true)
  const [refreshedAt, setRefreshedAt] = useState<Date>(new Date())

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const p = new URLSearchParams()
    if (activeRcId) {
      p.set('rcId', activeRcId)
      if (activeRc?.isDefault) p.set('isDefault', 'true')
    }

    const [dashRes, inboxRes, recipesRes] = await Promise.allSettled([
      fetch(`/api/reports/dashboard?${p}`).then(r => r.ok ? r.json() : null),
      fetch('/api/invoices/kpis').then(r => r.ok ? r.json() : null),
      fetch('/api/recipes?type=MENU&isActive=true').then(r => r.ok ? r.json() : null),
    ])

    if (dashRes.status === 'fulfilled' && dashRes.value && !dashRes.value.error) {
      setDash(dashRes.value)
    }
    if (inboxRes.status === 'fulfilled' && inboxRes.value) {
      setInbox(inboxRes.value)
    }
    if (recipesRes.status === 'fulfilled' && Array.isArray(recipesRes.value)) {
      setHighCost(
        recipesRes.value
          .filter((r: Recipe) => r.foodCostPct !== null && r.foodCostPct > 35)
          .sort((a: Recipe, b: Recipe) => (b.foodCostPct ?? 0) - (a.foodCostPct ?? 0))
      )
    }

    setLoading(false)
    setRefreshedAt(new Date())
  }, [activeRcId, activeRc])

  useEffect(() => { fetchAll() }, [fetchAll])

  const signals = buildSignals(dash, inbox, highCostRecipes)
  const hasHighSeverity = signals.some(s => s.severity === 'high')

  return (
    <div className="space-y-5 max-w-2xl">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Zap size={16} className="text-gold" />
            <h1 className="text-2xl font-bold text-gray-900">Signals</h1>
          </div>
          <p className="text-sm text-gray-400">
            What the loop is telling you right now — each one ends with something to do.
          </p>
        </div>
        <button
          onClick={fetchAll}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-700 transition-colors disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {refreshedAt.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })}
        </button>
      </div>

      {/* ── Loading ──────────────────────────────────────────── */}
      {loading && (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      )}

      {/* ── All clear ──────────────────────────────────────── */}
      {!loading && signals.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
            <CheckCircle2 size={22} className="text-green-500" />
          </div>
          <div>
            <p className="font-semibold text-gray-900">All clear</p>
            <p className="text-sm text-gray-400 mt-1">No signals right now. Check back after your next invoice or count.</p>
          </div>
        </div>
      )}

      {/* ── Signal cards ─────────────────────────────────────── */}
      {!loading && signals.length > 0 && (
        <>
          {hasHighSeverity && (
            <p className="text-[11px] font-semibold text-red-600 uppercase tracking-widest">
              Needs immediate attention
            </p>
          )}
          <div className="space-y-3">
            {signals.map(signal => {
              const Icon = signal.icon
              const styles = SEVERITY_STYLES[signal.severity]
              return (
                <div
                  key={signal.id}
                  className={`rounded-xl border p-4 ${styles.card}`}
                >
                  <div className="flex items-start gap-3">
                    {/* Severity dot + icon */}
                    <div className="relative shrink-0 mt-0.5">
                      <div className="w-8 h-8 rounded-lg bg-white/60 border border-white/80 flex items-center justify-center">
                        <Icon size={15} className="text-gray-600" />
                      </div>
                      <span className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border-2 border-white ${styles.dot}`} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <p className="text-sm font-semibold text-gray-900">{signal.title}</p>
                        <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${styles.badge}`}>
                          {SEVERITY_LABEL[signal.severity]}
                        </span>
                      </div>
                      <p className="text-xs text-gray-600 leading-relaxed">{signal.body}</p>
                      <Link
                        href={signal.href}
                        className="inline-flex items-center gap-1 mt-2.5 text-xs font-semibold text-gray-800 hover:text-gold transition-colors"
                      >
                        {signal.cta} <ArrowRight size={11} />
                      </Link>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <p className="text-[11px] text-gray-400 pt-2">
            Signals are derived from your live inventory, recipe costs, and invoice data. They refresh each time you load this page.
          </p>
        </>
      )}
    </div>
  )
}
