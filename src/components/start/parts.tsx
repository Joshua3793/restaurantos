'use client'
import type { ReactNode } from 'react'
import { Flame, Thermometer, TrendingUp, FileText, ClipboardList } from 'lucide-react'
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
}

export function greetingFor(d: Date): 'morning' | 'afternoon' | 'evening' {
  const h = d.getHours()
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
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
