'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { atLeast } from '@/lib/roles'
import { setScopeParams } from '@/lib/scope-params'
import { serviceStatus, type RcService, type ServiceStatus } from '@/lib/service-hours'
import { useNowMinute } from '@/components/prep/runsheet/useNowMinute'
import { ymd } from '@/components/temps/temp-utils'
import { defaultPhase, type Phase } from '@/lib/checklists/rules'
import type { TodayView } from '@/lib/checklists/today-types'
import type { HandoverNote } from '@/lib/pass'
import type { InboxList } from '@/components/inbox/format'
import { prepProgress, runningLow, type StartPrepItem, type StartOrderLine } from '@/lib/start-page'

// The last close for the active RC (GET /api/eod/handover). MANAGER only.
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
  foodCost: { pct: number | null; target: number } | null
  yesterday: { netSales: number; covers: number } | null
  lastClose: LastClose | null
  orders: OrdersResponse | null
  stations: TodayView['stations']
  handovers: HandoverNote[]
}

const EMPTY: Raw = {
  prep: [], foodCost: null, yesterday: null, lastClose: null, orders: null, stations: [], handovers: [],
}

const getJson = (url: string) =>
  fetch(url, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)

/**
 * Everything the Pass shows, for the active scope, refreshed every 60 s.
 * Desktop (/pass) and the phone (/today, LEAD+) render the same data two ways.
 *
 * The list is the Inbox (open items, NOW then TODAY); the stations strip and
 * last night's station notes come from the checklists. All three are per
 * revenue center, so they only load when one RC is selected. Money — sales,
 * food cost, the order list, the whole-kitchen close — loads for MANAGER+ only.
 */
export function useStartData() {
  const { activeRcId, activeRc, activeKind, activeLocationId, ready } = useRc()
  const { role, loading: userLoading } = useUser()
  const isManager = role != null && atLeast(role, 'MANAGER')
  const isLead = role != null && atLeast(role, 'LEAD')
  const { nowMs, nowMin } = useNowMinute()
  // Opening 5:00–13:59 Pacific, closing otherwise — the same default as the board.
  const phase: Phase = defaultPhase(new Date(nowMs))
  const rcOnly = activeKind === 'rc' && activeRcId ? activeRcId : null
  const [raw, setRaw] = useState<Raw>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [inbox, setInbox] = useState<InboxList | null>(null)
  const [inboxError, setInboxError] = useState(false)
  const [tick, setTick] = useState(0)
  const inboxSeq = useRef(0)
  const reload = useCallback(() => setTick(t => t + 1), [])

  /** The open Inbox for this kitchen. Only the latest reply lands. */
  const loadInbox = useCallback(async () => {
    const seq = ++inboxSeq.current
    if (!rcOnly || !isLead) { setInbox(null); setInboxError(false); return }
    const v = await getJson(`/api/inbox?${new URLSearchParams({ rcId: rcOnly, status: 'open' })}`)
    if (seq !== inboxSeq.current) return
    if (v && Array.isArray(v.items)) { setInbox(v as InboxList); setInboxError(false) }
    else setInboxError(true)
  }, [rcOnly, isLead])

  // A new kitchen: nothing from the old one (list, prep, figures) may show while the new one loads.
  useEffect(() => {
    inboxSeq.current++
    setInbox(null); setInboxError(false); setLoaded(false)
    setRaw(EMPTY)
  }, [rcOnly])

  useEffect(() => {
    // Wait for the role too: it decides which money blocks load, and loading
    // before it lands would run every request twice.
    if (!ready || userLoading) return
    let cancelled = false
    const scope = new URLSearchParams()
    setScopeParams(scope, { activeKind, activeRcId, activeRc, activeLocationId })
    const qs = scope.toString() ? `?${scope}` : ''
    const dayAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d) }
    const salesQs = new URLSearchParams(scope)
    salesQs.set('startDate', dayAgo(1)); salesQs.set('endDate', dayAgo(1))

    // Each block fills in as its data lands. `loaded` flips once the Inbox (the
    // list) is in, so it never flashes "nothing needs you" half-loaded.
    const load = () => {
      const put = <K extends keyof Raw>(key: K, value: Raw[K]) => {
        if (!cancelled) setRaw(r => ({ ...r, [key]: value }))
      }
      const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? v : [])
      loadInbox().then(() => { if (!cancelled) setLoaded(true) })
      getJson(`/api/prep/items${qs}`).then(v => put('prep', arr<StartPrepItem>(v)))

      if (rcOnly && isLead) {
        getJson(`/api/checklists/today?rcId=${rcOnly}&phase=${phase}`).then(v => put('stations', arr(v?.stations)))
        getJson(`/api/checklists/handovers?rcId=${rcOnly}`).then(v => put('handovers', arr<HandoverNote>(v?.notes)))
      } else {
        put('stations', [])
        put('handovers', [])
      }

      if (isManager) {
        getJson(`/api/insights/cost-chrome${qs}`).then(v => put('foodCost', v
          ? { pct: v.foodCostPct == null ? null : Number(v.foodCostPct), target: Number(v.targetPct ?? 27) }
          : null))
        getJson(`/api/sales?${salesQs}`).then(v => put('yesterday', Array.isArray(v) && v.length > 0
          ? {
              netSales: v.reduce((t: number, e: { totalRevenue: unknown }) => t + Number(e.totalRevenue), 0),
              covers: v.reduce((t: number, e: { covers: number | null }) => t + (e.covers ?? 0), 0),
            }
          : null))
      } else {
        put('foodCost', null)
        put('yesterday', null)
      }
      if (isManager && rcOnly) {
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
    // A hidden tab does not poll; it catches up the moment it is visible again.
    const tick = () => { if (document.visibilityState === 'visible') load() }
    const id = setInterval(tick, 60_000)
    document.addEventListener('visibilitychange', tick)
    return () => { cancelled = true; clearInterval(id); document.removeEventListener('visibilitychange', tick) }
  }, [ready, userLoading, activeKind, activeRcId, activeRc, activeLocationId, tick, isManager, isLead, rcOnly, phase, loadInbox])

  const services = useMemo<RcService[]>(
    () => (activeKind === 'rc' ? ((activeRc?.services ?? []) as RcService[]) : []),
    [activeKind, activeRc],
  )
  // No single RC selected → no schedule to report on; the clock shows prep only.
  const status = useMemo<ServiceStatus>(
    () => serviceStatus(services, nowMin, activeRc?.prepLeadMinutes ?? null),
    [services, nowMin, activeRc],
  )

  const progress = useMemo(() => prepProgress(raw.prep), [raw.prep])
  const low = useMemo(
    () => runningLow(raw.orders ? raw.orders.suppliers.flatMap(s => s.lines) : []),
    [raw.orders],
  )

  return {
    loaded,
    reload,
    loadInbox,
    nowMs,
    nowMin,
    phase,
    services,
    status,
    progress,
    low,
    isManager,
    inbox,
    inboxError,
    stations: raw.stations,
    handovers: raw.handovers,
    hasOrders: raw.orders != null,
    lastClose: raw.lastClose,
    yesterday: raw.yesterday,
    foodCost: raw.foodCost,
    rcId: rcOnly,
    isRc: rcOnly != null,
    rcName: activeKind === 'rc' ? activeRc?.name ?? null : null,
  }
}

export type StartData = ReturnType<typeof useStartData>
