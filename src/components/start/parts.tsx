'use client'
import { useEffect, useState, type ReactNode } from 'react'
import { Flame, Thermometer, TrendingUp, FileText, ClipboardList, ClipboardCheck } from 'lucide-react'
import type { NeedItem, NeedKind } from '@/lib/start-page'
import { fmtDurationWords } from '@/lib/start-page'
import type { ServiceStatus } from '@/lib/service-hours'
import type { StartData } from './useStartData'

export const NEED_ICON: Record<NeedKind, typeof Flame> = {
  prep: Flame,
  temp: Thermometer,
  price: TrendingUp,
  invoice: FileText,
  count: ClipboardList,
  checklist: ClipboardCheck,
}

export function greetingFor(d: Date): 'morning' | 'afternoon' | 'evening' {
  const h = d.getHours()
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
}

/**
 * The first name for the greeting: the first candidate that is a real name
 * (the linked crew member, then the login's name). An email is never a name —
 * "Morning, joshua37ca" read like a robot — so with no name the greeting is
 * just "Morning." (null here).
 */
export function firstNameOf(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    const t = c?.trim()
    if (!t || t.includes('@')) continue
    const first = t.split(/\s+/)[0]
    if (first) return first
  }
  return null
}

/**
 * The linked crew member's name (Cook.userId → /api/prep/me), for pages that
 * do not already load it. undefined while loading, null when not linked.
 */
export function useCookName(): string | null | undefined {
  const [name, setName] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    fetch('/api/prep/me', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(v => { if (!cancelled) setName(v?.cook?.name ?? null) })
      .catch(() => { if (!cancelled) setName(null) })
    return () => { cancelled = true }
  }, [])
  return name
}

/** "Morning" / "Afternoon" / "Evening" — the short phone greeting word. */
export function greetingWord(d: Date): string {
  const g = greetingFor(d)
  return g === 'morning' ? 'Morning' : g === 'afternoon' ? 'Afternoon' : 'Evening'
}

export function crumbDate(d: Date): string {
  return d.toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).toUpperCase()
}

/**
 * The one sentence under the greeting: where service is, then how many things
 * need the chef now vs later. "Brunch in 1 h 20 m. 2 things to fix before then, 2 for later today."
 */
export function Headline({ status, needs }: { status: ServiceStatus; needs: NeedItem[] }): ReactNode {
  const nowN = needs.filter(n => n.when === 'now').length
  const todayN = needs.length - nowN
  const things = (n: number) => `${n} ${n === 1 ? 'thing' : 'things'}`
  const lead =
    status.kind === 'upcoming' ? <>{status.service.name} in <b>{fmtDurationWords(status.minsUntil)}</b>. </>
      : status.kind === 'underway' ? <>{status.service.name} is on. </>
        : null
  if (nowN === 0 && todayN === 0) return <>{lead}Nothing needs you right now.</>
  return (
    <>
      {lead}
      {nowN > 0 && <><b className="text-red-text">{things(nowN)}</b> to fix {status.kind === 'upcoming' ? 'before then' : 'now'}</>}
      {nowN > 0 && todayN > 0 && ', '}
      {todayN > 0 && <>{nowN > 0 ? <b>{todayN}</b> : <b>{things(todayN)}</b>} for later today</>}
      .
    </>
  )
}

export type ScoreRow = {
  key: 'sales' | 'purchases' | 'foodCost' | 'drift'
  label: string
  value: string
  tone?: 'bad' | 'ok' | 'muted'
  /** One plain line under the label, for a number that is easy to misread. */
  hint?: string
  href?: string
}

/**
 * Yesterday's sales (with covers), this week's purchases ÷ sales, and the true
 * food cost + stock drift from the last two counts.
 *
 * The weekly ratio is purchases ÷ sales week-to-date, NOT plate cost: one big
 * delivery on a Monday sends it past 100%. It used to read "Food cost this week"
 * and showed 42.6% while Reports said 27.4%, so it now says what it is, carries
 * no target colour, and the real food cost (last count) sits right under it.
 */
export function scoreRows(d: Pick<StartData, 'yesterday' | 'foodCost' | 'countFoodCost' | 'isRc'>, fmtMoney: (n: number) => string): ScoreRow[] {
  const y = d.yesterday
  const rows: ScoreRow[] = []
  // 0 covers means Toast sent no guest counts, not an empty room — show sales alone.
  if (y) rows.push({ key: 'sales', label: 'Sales yesterday', value: y.covers ? `${fmtMoney(y.netSales)} · ${y.covers} covers` : fmtMoney(y.netSales) })
  if (d.foodCost) {
    const { pct } = d.foodCost
    rows.push({
      key: 'purchases',
      label: 'Purchases ÷ sales (this week)',
      value: pct == null ? '—' : `${pct.toFixed(1)}%`,
      tone: pct == null ? 'muted' : undefined,
      hint: 'What we bought ÷ what we sold. Runs high early in the week.',
    })
  }
  const c = d.countFoodCost
  // The count food cost is whole-business (the route takes no kitchen filter) —
  // say so when one kitchen is picked, like /variance does.
  const wholeBusiness = d.isRc ? 'Whole business, not just this kitchen.' : undefined
  if (c && c.actualPct != null) {
    const target = d.foodCost?.target
    rows.push({
      key: 'foodCost',
      label: 'Food cost (last count)',
      value: target != null ? `${c.actualPct.toFixed(1)}% / ${target.toFixed(1)}%` : `${c.actualPct.toFixed(1)}%`,
      tone: target == null ? undefined : c.actualPct > target ? 'bad' : 'ok',
      hint: wholeBusiness,
      href: '/variance',
    })
  }
  if (c && c.driftPts != null) {
    const pts = `${c.driftPts > 0 ? '+' : c.driftPts < 0 ? '−' : ''}${Math.abs(c.driftPts).toFixed(1)} pts`
    const money = c.driftDollars != null ? ` · ${c.driftDollars > 0 ? '+' : c.driftDollars < 0 ? '−' : ''}${fmtMoney(Math.abs(c.driftDollars))}` : ''
    rows.push({ key: 'drift', label: 'Stock drift', value: pts + money, tone: c.driftPts > 0 ? 'bad' : 'ok', hint: wholeBusiness, href: '/variance' })
  }
  return rows
}

/** Sign-off names are sometimes the closer's email — show the part before the @. */
export function personName(s: string | null): string | null {
  return s ? s.split('@')[0] : null
}

export function signedOff(c: { signedOffByName: string | null; signedOffAt: string | null }): string {
  const time = c.signedOffAt
    ? new Date(c.signedOffAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
    : null
  return [personName(c.signedOffByName), time && `closed ${time}`].filter(Boolean).join(' · ')
}
