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

/** Yesterday's sales/covers + this week's food cost vs target. */
export function scoreRows(d: Pick<StartData, 'yesterday' | 'foodCost'>, fmtMoney: (n: number) => string) {
  const y = d.yesterday
  const rows: { label: string; value: string; tone?: 'bad' | 'ok' | 'muted' }[] = []
  if (y) rows.push({ label: 'Sales yesterday', value: fmtMoney(y.netSales) })
  // 0 covers means Toast sent no guest counts, not an empty room — leave the row out.
  if (y?.covers) rows.push({ label: 'Covers yesterday', value: String(y.covers) })
  if (d.foodCost) {
    const { pct, target } = d.foodCost
    rows.push({
      label: 'Food cost this week',
      value: pct == null ? '—' : `${pct.toFixed(1)}%`,
      tone: pct == null ? 'muted' : pct > target ? 'bad' : 'ok',
    })
    rows.push({ label: 'Target', value: `${target.toFixed(1)}%`, tone: 'muted' })
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
