'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Clock, Printer, ArrowLeft, Mail } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { setScopeParams } from '@/lib/scope-params'
import { atLeast } from '@/lib/roles'
import { PageHead } from '@/components/layout/PageHead'
import { SubNav } from '@/components/layout/SubNav'
import { formatCurrency } from '@/lib/utils'
import type { TempUnit } from '@/components/temps/temp-utils'
import {
  EodKpiRow, DayInReview, CloseRail, CloseDown, RcPicker, LoopStrip, SetsUpTomorrow, PH_TARGET_PCT,
} from './eod-components'

export interface EodSummary {
  date: string
  netSales: number
  foodSales: number // reserved for later phase — not read in MVP
  covers: number
  foodCostDollars: number
  foodCostPct: number | null
  avgSpend: number | null
  topSellers: Array<{ id: string; name: string; menuPrice: number | null; units: number }> // menuPrice reserved for later phase — not read in MVP
  slowMovers: Array<{ id: string; name: string; menuPrice: number | null; units: number }> // menuPrice reserved for later phase — not read in MVP
  wasteFlags: Array<{ id: string; name: string; meta: string; loggedBy: string; cost: number }>
  priceFlags: Array<{ id: string; name: string; pct: number | null }>
  netSalesForecast: number | null
  forecastBasis: number
}

// The sign-off gate (computeProgress in src/lib/eod-close.ts): temps ready AND
// every station's closing run signed off. done/total count stations + 1 for temps.
export interface EodProgressDTO {
  done: number
  total: number
  blockers: number
  ready: boolean
  tempsReady: boolean
  hasTempUnits: boolean
  stationsSigned: number
  stationsTotal: number
  /** Blocker jobs left on the whole-kitchen closing list (e.g. gas off). */
  sharedBlockersLeft: number
}

export interface EodCloseState {
  date: string
  close: {
    id: string
    status: 'DRAFT' | 'CLOSED'
    handoverNote: string | null
    signedOffByName: string | null
    signedOffAt: string | null
    // Omitted from the API response entirely for a Lead (money — see the GET
    // handler in api/eod/close/route.ts), alongside the four fields below.
    snapshot?: unknown
    labourCost?: number | null
    grossSales?: number | null
    compsVoids?: number | null
    discounts?: number | null
  }
  progress: EodProgressDTO
}

export default function EndOfDayPage() {
  const router = useRouter()
  const { activeRcId, activeRc, activeKind, activeLocationId, revenueCenters, setActiveRcId, ready: scopeReady } = useRc()
  const { role, loading: userLoading } = useUser()
  // A Lead runs the operational close but the clearance ladder is explicit
  // that Leads see "no cost or money" — /api/eod/summary and /api/eod/orders
  // are MANAGER-only and would 403 for them, so skip those fetches entirely
  // rather than let them fail.
  const canSeeMoney = role !== 'LEAD' && role !== 'STAFF'
  // role starts out null while /api/me is in flight, and `null !== 'LEAD'`
  // is true — so canSeeMoney is true during that window for EVERY role,
  // Lead included. showMoney folds the loading gate into the same flag so
  // every money fetch/UI check below only has one thing to test, instead of
  // each call site having to remember to AND in userLoading itself (the
  // summary effect used to be the only one that did).
  const showMoney = !userLoading && canSeeMoney
  const [data, setData] = useState<EodSummary | null>(null)
  const [closeState, setCloseState] = useState<EodCloseState | null>(null)
  const [tempUnits, setTempUnits] = useState<TempUnit[]>([])
  const [signoffError, setSignoffError] = useState<string | null>(null)

  const isRcScoped = activeKind === 'rc' && !!activeRcId

  useEffect(() => {
    if (!scopeReady) return   // wait for the scope, or this fires an unscoped load first
    // showMoney is false for the whole userLoading window, so this can't
    // fire before we know the real role; once loading flips to false it's
    // in the dependency array below, so a MANAGER's data still loads.
    if (!showMoney) { setData(null); return }
    const params = new URLSearchParams()
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
    const qs = params.toString()
    fetch(`/api/eod/summary${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d) })
      .catch(() => {})
  }, [activeRcId, activeRc, activeKind, activeLocationId, showMoney, scopeReady])

  const loadClose = useCallback(() => {
    if (!isRcScoped) { setCloseState(null); setTempUnits([]); return }
    fetch(`/api/eod/close?rcId=${activeRcId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then((d: EodCloseState | null) => {
        if (!d) return
        setCloseState(d)
        setSignoffError(null)
        return fetch(`/api/temps/units?rcId=${activeRcId}&date=${d.date}`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : [])
          .then(units => { if (Array.isArray(units)) setTempUnits(units) })
      })
      .catch(() => {})
  }, [isRcScoped, activeRcId])

  useEffect(() => { loadClose() }, [loadClose])

  // Cooks sign their stations off on their phones, so the gate must re-read
  // itself: every 30 s while the close is open and the tab is visible, and on
  // returning to the tab. Only the gate is merged — the handover note and the
  // money fields stay exactly as the user left them (a save may be pending).
  const [gateTick, setGateTick] = useState(0)
  const rcRef = useRef(activeRcId)
  rcRef.current = activeRcId
  const lastGateRead = useRef(0)
  const refreshGate = useCallback(() => {
    if (!isRcScoped || !activeRcId) return
    if (Date.now() - lastGateRead.current < 2_000) return   // focus + visibilitychange fire together
    lastGateRead.current = Date.now()
    const rcId = activeRcId
    fetch(`/api/eod/close?rcId=${rcId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then((d: EodCloseState | null) => {
        if (!d || rcRef.current !== rcId) return
        setCloseState(prev => {
          if (!prev || prev.close.id !== d.close.id) return prev
          // Closed or reopened elsewhere: take the whole answer.
          if (prev.close.status !== d.close.status) return d
          return { ...prev, date: d.date, progress: d.progress }
        })
        setGateTick(t => t + 1)
        return fetch(`/api/temps/units?rcId=${rcId}&date=${d.date}`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : [])
          .then(units => { if (Array.isArray(units) && rcRef.current === rcId) setTempUnits(units) })
      })
      .catch(() => {})
  }, [isRcScoped, activeRcId])

  const isDraft = closeState?.close.status === 'DRAFT'
  useEffect(() => {
    if (!isRcScoped || !isDraft) return
    const tick = () => { if (document.visibilityState === 'visible') refreshGate() }
    const id = setInterval(tick, 30_000)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('focus', tick)
    }
  }, [isRcScoped, isDraft, refreshGate])

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveHandover = useCallback((text: string) => {
    if (!activeRcId) return
    setCloseState(prev => prev ? { ...prev, close: { ...prev.close, handoverNote: text } } : prev)
    if (handoverTimer.current) clearTimeout(handoverTimer.current)
    handoverTimer.current = setTimeout(() => {
      fetch('/api/eod/close', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rcId: activeRcId, handoverNote: text }),
      }).catch(() => {})
    }, 600)
  }, [activeRcId])

  const closeFieldsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveCloseFields = useCallback((fields: { labourCost?: number | null; grossSales?: number | null; compsVoids?: number | null; discounts?: number | null }) => {
    if (!activeRcId) return
    setCloseState(prev => prev ? { ...prev, close: { ...prev.close, ...fields } } : prev)
    if (closeFieldsTimer.current) clearTimeout(closeFieldsTimer.current)
    closeFieldsTimer.current = setTimeout(() => {
      fetch('/api/eod/close', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rcId: activeRcId, ...fields }),
      })
        .then(() => loadClose())
        .catch(() => {})
    }, 600)
  }, [activeRcId, loadClose])

  const signOff = useCallback(() => {
    if (!activeRcId) return
    setSignoffError(null)
    fetch('/api/eod/close/signoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rcId: activeRcId }),
    })
      .then(async r => {
        const body = await r.json().catch(() => null)
        if (r.ok) {
          // /pass is MANAGER-gated — a Lead sent there would bounce straight
          // back out through middleware into a redirect loop. /today is the
          // role-aware home and resolves correctly for everyone.
          router.push(role != null && atLeast(role, 'MANAGER') ? '/pass' : '/today')
          return
        }
        if (r.status === 409 && body) {
          setSignoffError(body.error ?? 'Not ready to close')
          setCloseState(prev => prev ? { ...prev, progress: body.progress } : prev)
        } else {
          setSignoffError(body?.error ?? 'Failed to sign off')
        }
      })
      .catch(() => setSignoffError('Failed to sign off'))
  }, [activeRcId, router, role])

  const reopen = useCallback(() => {
    if (!activeRcId) return
    fetch('/api/eod/close/reopen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rcId: activeRcId }),
    })
      .then(r => { if (r.ok) loadClose() })
      .catch(() => {})
  }, [activeRcId, loadClose])

  const [emailState, setEmailState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const emailOwner = useCallback(() => {
    setEmailState('sending')
    fetch('/api/eod/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rcName: activeRc?.name ?? undefined,
        date: data?.date,
        netSales: data?.netSales,
        covers: data?.covers,
        foodCostDollars: data?.foodCostDollars,
        foodCostPct: data?.foodCostPct ?? null,
        checklistDone: closeState?.progress.done,
        checklistTotal: closeState?.progress.total,
        closed: closeState?.close.status === 'CLOSED',
        handoverNote: closeState?.close.handoverNote ?? null,
      }),
    })
      .then(r => {
        setEmailState(r.ok ? 'sent' : 'failed')
        setTimeout(() => setEmailState('idle'), 2500)
      })
      .catch(() => {
        setEmailState('failed')
        setTimeout(() => setEmailState('idle'), 2500)
      })
  }, [activeRc, data, closeState])

  const fcPct = data?.foodCostPct ?? null
  const over = fcPct != null && fcPct > PH_TARGET_PCT

  return (
    <>
      <SubNav
        tabs={[
          { href: '/pass', label: 'Pass' },
          { href: '/preshift', label: 'Pre-shift' },
          { href: '/end-of-day', label: 'End-of-day', icon: <Clock size={14} /> },
        ]}
      />
      <div id="eod-report" className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">

        {/* Cost-chrome strip */}
        <div className="eod-no-print hidden md:flex items-center gap-4 mb-5 px-4 py-2.5 bg-paper border border-line rounded-[10px] font-mono text-[11px]">
          <span className="text-ink-3">Stations signed off</span>
          <span className="text-ink-3 tabular-nums">
            {closeState ? `${closeState.progress.stationsSigned} / ${closeState.progress.stationsTotal}` : '— / —'}
          </span>
          {showMoney ? (
            <>
              <span className="w-px h-3.5 bg-line" />
              <span className="text-ink-3">Food cost · today</span>
              <span className={`tabular-nums font-semibold ${over ? 'text-red-text' : 'text-ink'}`}>{fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}</span>
              <span className="w-px h-3.5 bg-line" />
              <span className="text-ink-3">Net sales</span>
              <span className="text-ink font-semibold tabular-nums">{data ? formatCurrency(data.netSales) : '—'}</span>
            </>
          ) : (
            <>
              <span className="w-px h-3.5 bg-line" />
              <span className="text-ink-4">Sales and cost figures are managed by your manager.</span>
            </>
          )}
          <span className="flex-1" />
          <span className="text-ink-4">sign-off closes the loop · feeds tomorrow&apos;s <Link href="/pass" className="text-gold-2 border-b border-dashed border-current">Pass</Link></span>
        </div>

        <PageHead
          crumbs={<><Clock size={12} /> TODAY / END-OF-DAY</>}
          title={<>Service is <em className="font-fraunces italic font-medium text-gold-2">closed</em>.</>}
          sub={
            !showMoney
              ? <>Sales and cost figures are managed by your manager. Get every station signed off and temps logged, then sign off to hand over.</>
              : data
                ? <>{data.covers} covers · <b>{formatCurrency(data.netSales)}</b> net · food cost ran <b className={over ? 'text-red-text' : ''}>{fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}</b>. Review the day, then sign off to open tomorrow with real numbers.</>
                : <>Loading today&apos;s close…</>
          }
          actions={
            <>
              <Link href="/pass" className="eod-no-print inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
                <ArrowLeft size={13} /> Back to Pass
              </Link>
              <button onClick={() => window.print()} className="eod-no-print inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
                <Printer size={13} /> Print report
              </button>
              {/* /api/eod/email is MANAGER-only and its payload is a sales/cost digest —
                  a Lead has nothing to send here and the request would just 403.
                  showMoney (not canSeeMoney) so this stays hidden through the
                  loading window too, not just once role resolves to LEAD. */}
              {showMoney && (
                <button
                  onClick={emailOwner}
                  disabled={emailState === 'sending'}
                  className="eod-no-print inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <Mail size={13} />
                  {emailState === 'sending' ? 'Sending…' : emailState === 'sent' ? 'Sent ✓' : emailState === 'failed' ? 'Failed' : 'Email owner'}
                </button>
              )}
            </>
          }
        />

        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div>
            <EodKpiRow data={data} target={PH_TARGET_PCT} closeState={closeState} canSeeMoney={showMoney} />
            <DayInReview data={data} target={PH_TARGET_PCT} />
            {isRcScoped ? (
              <CloseDown
                rcId={activeRcId!}
                closeState={closeState}
                tempUnits={tempUnits}
                refreshTick={gateTick}
              />
            ) : (
              <RcPicker revenueCenters={revenueCenters} onPick={setActiveRcId} />
            )}
            {/* SetsUpTomorrow's canSeeMoney gates whether OrderSuggestionsCard mounts and
                fires its own GET /api/eod/orders (MANAGER-only) in a mount effect — pass
                showMoney, not canSeeMoney, so that fetch can't slip through while role is
                still resolving (activeRcId can be truthy before /api/me returns). */}
            {isRcScoped && <SetsUpTomorrow rcId={activeRcId!} canSeeMoney={showMoney} />}
            <LoopStrip />
          </div>
          <CloseRail
            data={data}
            closeState={closeState}
            isRcScoped={isRcScoped}
            canSeeMoney={showMoney}
            signoffError={signoffError}
            onSaveHandover={saveHandover}
            onSaveClose={saveCloseFields}
            onSignOff={signOff}
            onReopen={reopen}
          />
        </div>
      </div>

      {/* Print styles — only #eod-report prints, chrome/actions hidden */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #eod-report, #eod-report * { visibility: visible; }
          #eod-report { position: absolute; left: 0; top: 0; width: 100%; padding: 0; }
          .eod-no-print { display: none !important; }
        }
      `}</style>
    </>
  )
}
