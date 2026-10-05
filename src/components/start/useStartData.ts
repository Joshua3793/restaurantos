'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'
import { serviceStatus, type RcService, type ServiceStatus } from '@/lib/service-hours'
import { useNowMinute } from '@/components/prep/runsheet/useNowMinute'
import { ymd } from '@/components/temps/temp-utils'
import {
  buildNeeds, prepProgress, daysSinceCount, runningLow,
  type StartPrepItem, type StartTempUnit, type StartPriceAlert, type StartRecipeAlert,
  type StartCountSession, type StartOrderLine, type NeedItem,
} from '@/lib/start-page'

// The last close for the active RC (GET /api/eod/handover).
export interface LastClose {
  handoverNote: string | null
  signedOffByName: string | null
  signedOffAt: string | null
  businessDate: string
}

/** A close older than this many days is not "last night" — the card hides. */
const CLOSE_FRESH_DAYS = 2

interface OrdersResponse {
  suppliers: { supplierName: string; lines: StartOrderLine[] }[]
  lineCount: number
  total: number
}

interface Raw {
  prep: StartPrepItem[]
  temps: StartTempUnit[]
  priceAlerts: StartPriceAlert[]
  recipeAlerts: StartRecipeAlert[]
  invoicesAwaiting: number
  counts: StartCountSession[]
  foodCost: { pct: number | null; target: number } | null
  yesterday: { netSales: number; covers: number } | null
  lastClose: LastClose | null
  orders: OrdersResponse | null
}

const EMPTY: Raw = {
  prep: [], temps: [], priceAlerts: [], recipeAlerts: [], invoicesAwaiting: 0,
  counts: [], foodCost: null, yesterday: null, lastClose: null, orders: null,
}

const getJson = (url: string) =>
  fetch(url, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)

/**
 * Everything the start page shows, for the active scope, refreshed every 60 s.
 * Desktop (/pass) and mobile (/today) render the same data two ways.
 *
 * Last night's close and the running-low list are per revenue center (par and
 * the close live on the RC), so they only load when one RC is selected.
 */
export function useStartData() {
  const { activeRcId, activeRc, activeKind, activeLocationId, ready } = useRc()
  const { nowMs, nowMin } = useNowMinute()
  const [raw, setRaw] = useState<Raw>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const scope = new URLSearchParams()
    setScopeParams(scope, { activeKind, activeRcId, activeRc, activeLocationId })
    const qs = scope.toString() ? `?${scope}` : ''
    const tempQs = new URLSearchParams(scope)
    tempQs.set('date', ymd(new Date()))
    const rcOnly = activeKind === 'rc' && activeRcId ? activeRcId : null
    const dayAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d) }
    const salesQs = new URLSearchParams(scope)
    salesQs.set('startDate', dayAgo(1)); salesQs.set('endDate', dayAgo(1))

    // Each block fills in as its data lands — the slow ones (prep items, the
    // order list) must not hold back the clock or the food-cost row. `loaded`
    // flips once every source of the Needs-you list is in, so the list never
    // flashes "nothing needs you" while half its inputs are still missing.
    const load = () => {
      const put = <K extends keyof Raw>(key: K, value: Raw[K]) => {
        if (!cancelled) setRaw(r => ({ ...r, [key]: value }))
      }
      const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? v : [])
      const needsSources = Promise.all([
        getJson(`/api/prep/items${qs}`).then(v => put('prep', arr<StartPrepItem>(v))),
        getJson(`/api/temps/units?${tempQs}`).then(v => put('temps', arr<StartTempUnit>(v))),
        getJson('/api/invoices/alerts').then(v => {
          put('priceAlerts', v?.priceAlerts ?? [])
          put('recipeAlerts', v?.recipeAlerts ?? [])
        }),
        getJson(`/api/invoices/kpis${qs}`).then(v => put('invoicesAwaiting', Number(v?.awaitingApprovalCount ?? 0))),
        getJson(`/api/count/sessions${qs}`).then(v => put('counts', arr<StartCountSession>(v))),
      ])
      needsSources.then(() => { if (!cancelled) setLoaded(true) })

      getJson(`/api/insights/cost-chrome${qs}`).then(v => put('foodCost', v
        ? { pct: v.foodCostPct == null ? null : Number(v.foodCostPct), target: Number(v.targetPct ?? 27) }
        : null))
      getJson(`/api/sales?${salesQs}`).then(v => put('yesterday', Array.isArray(v) && v.length > 0
        ? {
            netSales: v.reduce((t: number, e: { totalRevenue: unknown }) => t + Number(e.totalRevenue), 0),
            covers: v.reduce((t: number, e: { covers: number | null }) => t + (e.covers ?? 0), 0),
          }
        : null))
      if (rcOnly) {
        // Only a recent close is "last night" — a months-old note must not read as news.
        getJson(`/api/eod/handover?rcId=${rcOnly}`).then(v => put('lastClose',
          v?.businessDate && v.businessDate >= dayAgo(CLOSE_FRESH_DAYS) ? v : null))
        getJson(`/api/eod/orders?rcId=${rcOnly}`).then(v => put('orders', v?.suppliers ? v : null))
      } else {
        put('lastClose', null)
        put('orders', null)
      }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [ready, activeKind, activeRcId, activeRc, activeLocationId, tick])

  const services = useMemo<RcService[]>(
    () => (activeKind === 'rc' ? ((activeRc?.services ?? []) as RcService[]) : []),
    [activeKind, activeRc],
  )
  // No single RC selected → no schedule to report on; the clock shows prep only.
  const status = useMemo<ServiceStatus>(
    () => serviceStatus(services, nowMin, activeRc?.prepLeadMinutes ?? null),
    [services, nowMin, activeRc],
  )
  const serviceName = status.kind === 'upcoming' || status.kind === 'underway' ? status.service.name : null

  const needs = useMemo<NeedItem[]>(() => buildNeeds({
    prep: raw.prep,
    temps: raw.temps,
    priceAlerts: raw.priceAlerts,
    recipeAlerts: raw.recipeAlerts,
    invoicesAwaiting: raw.invoicesAwaiting,
    countDays: daysSinceCount(raw.counts, nowMs),
    serviceName,
  }), [raw, nowMs, serviceName])

  const progress = useMemo(() => prepProgress(raw.prep), [raw.prep])
  const low = useMemo(
    () => runningLow(raw.orders ? raw.orders.suppliers.flatMap(s => s.lines) : []),
    [raw.orders],
  )

  return {
    loaded,
    reload,
    nowMin,
    services,
    status,
    needs,
    progress,
    low,
    hasOrders: raw.orders != null,
    lastClose: raw.lastClose,
    yesterday: raw.yesterday,
    foodCost: raw.foodCost,
    isRc: activeKind === 'rc' && !!activeRcId,
    rcName: activeKind === 'rc' ? activeRc?.name ?? null : null,
  }
}

export type StartData = ReturnType<typeof useStartData>
