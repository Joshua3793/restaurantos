'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock, Printer, ArrowLeft } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'
import { PageHead } from '@/components/layout/PageHead'
import { SubNav } from '@/components/layout/SubNav'
import { formatCurrency } from '@/lib/utils'
import { EodKpiRow, DayInReview, CloseRail, LoopStrip, PH_TARGET_PCT, PH_LABOUR_PCT } from './eod-components'

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
}

export default function EndOfDayPage() {
  const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()
  const [data, setData] = useState<EodSummary | null>(null)

  useEffect(() => {
    const params = new URLSearchParams()
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
    const qs = params.toString()
    fetch(`/api/eod/summary${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d) })
      .catch(() => {})
  }, [activeRcId, activeRc, activeKind, activeLocationId])

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
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">

        {/* Cost-chrome strip — checklist/blockers are Phase 2 placeholders */}
        <div className="hidden md:flex items-center gap-4 mb-5 px-4 py-2.5 bg-paper border border-line rounded-[10px] font-mono text-[11px]">
          <span className="text-ink-3">Close checklist</span>
          <span className="text-ink-3 tabular-nums" title="Checklist ships in Phase 2">0 / 20 <span className="text-ink-4">est</span></span>
          <span className="w-px h-3.5 bg-line" />
          <span className="text-ink-3">Food cost · today</span>
          <span className={`tabular-nums font-semibold ${over ? 'text-red-text' : 'text-ink'}`}>{fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}</span>
          <span className="w-px h-3.5 bg-line" />
          <span className="text-ink-3">Net sales</span>
          <span className="text-ink font-semibold tabular-nums">{data ? formatCurrency(data.netSales) : '—'}</span>
          <span className="flex-1" />
          <span className="text-ink-4">sign-off closes the loop · feeds tomorrow&apos;s <Link href="/pass" className="text-gold-2 border-b border-dashed border-current">Pass</Link></span>
        </div>

        <PageHead
          crumbs={<><Clock size={12} /> TODAY / END-OF-DAY</>}
          title={<>Service is <em className="font-fraunces italic font-medium text-gold-2">closed</em>.</>}
          sub={data ? <>{data.covers} covers · <b>{formatCurrency(data.netSales)}</b> net · food cost ran <b className={over ? 'text-red-text' : ''}>{fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}</b>. Review the day, then sign off to open tomorrow with real numbers.</> : <>Loading today&apos;s close…</>}
          actions={
            <>
              <Link href="/pass" className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
                <ArrowLeft size={13} /> Back to Pass
              </Link>
              <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
                <Printer size={13} /> Print report
              </button>
            </>
          }
        />

        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div>
            <EodKpiRow data={data} target={PH_TARGET_PCT} labourPct={PH_LABOUR_PCT} />
            <DayInReview data={data} target={PH_TARGET_PCT} />
            <LoopStrip />
          </div>
          <CloseRail data={data} />
        </div>
      </div>
    </>
  )
}
