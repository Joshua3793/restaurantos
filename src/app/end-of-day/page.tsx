'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Clock, Printer, ArrowLeft, Mail } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { setScopeParams } from '@/lib/scope-params'
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

export interface EodCheckItemDTO {
  id: string
  section: string
  title: string
  meta: string | null
  sortOrder: number
  isBlocker: boolean
}

export interface EodProgressDTO {
  done: number
  total: number
  blockers: number
  ready: boolean
  tempsReady: boolean
  hasTempUnits: boolean
}

export interface EodCloseState {
  date: string
  items: EodCheckItemDTO[]
  doneItemIds: string[]
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
  const { activeRcId, activeRc, activeKind, activeLocationId, revenueCenters, setActiveRcId } = useRc()
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
  }, [activeRcId, activeRc, activeKind, activeLocationId, showMoney])

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

  // ── Handlers ──────────────────────────────────────────────────────────────
  const toggleItem = useCallback((itemId: string, done: boolean) => {
    if (!activeRcId) return
    // Optimistic doneItemIds update; progress + authoritative doneItemIds come back from the API.
    setCloseState(prev => prev ? {
      ...prev,
      doneItemIds: done ? [...new Set([...prev.doneItemIds, itemId])] : prev.doneItemIds.filter(id => id !== itemId),
    } : prev)
    fetch('/api/eod/close/entry', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rcId: activeRcId, itemId, done }),
    })
      .then(r => r.ok ? r.json() : null)
      .then((d: { progress: EodProgressDTO; doneItemIds: string[] } | null) => {
        if (!d) return
        setCloseState(prev => prev ? { ...prev, progress: d.progress, doneItemIds: d.doneItemIds } : prev)
      })
      .catch(() => {})
  }, [activeRcId])

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
          router.push('/pass')
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
  }, [activeRcId, router])

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
          <span className="text-ink-3">Close checklist</span>
          <span className="text-ink-3 tabular-nums">
            {closeState ? `${closeState.progress.done} / ${closeState.progress.total}` : '— / —'}
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
              ? <>Sales and cost figures are managed by your manager. Run the checklist and temps, then sign off to hand over.</>
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
                closeState={closeState}
                tempUnits={tempUnits}
                onToggleItem={toggleItem}
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
