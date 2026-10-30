// Shapes of GET /api/checklists/today, shared by the route and the page. Pure.
import type { Phase } from './rules'
import type { StationStatus } from './station-status'

export type TodayLine = {
  id: string
  title: string
  status: 'TODO' | 'DONE' | 'FLAGGED'
  isBlocker: boolean
  byName: string | null
  /** A flagged job a lead has marked fixed. */
  fixed: boolean
}

export type TodayStation = {
  id: string
  name: string
  color: string
  isShared: boolean
  crew: string[]
  handled: number
  total: number
  status: StationStatus
  signedOffByName: string | null
  signedOffAt: string | null
  lines: TodayLine[]
}

export type TodayFlag = {
  lineId: string
  stationName: string
  title: string
  reason: 'BROKEN' | 'RAN_OUT' | 'OUT_OF_RANGE' | 'OTHER' | null
  note: string | null
  value: number | null
  unit: string | null
  byName: string | null
  at: string | null
}

export type TodayView = {
  phase: Phase
  businessDate: string
  stations: TodayStation[]
  flags: TodayFlag[]
}

/** 'YYYY-MM-DD' minus n days, by calendar arithmetic in UTC (no timezone drift). */
export function minusDays(businessDate: string, n: number): string {
  const d = new Date(businessDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
