// src/lib/rc-schedule.ts
// Server-side validation + normalization for revenue-center scheduling fields.
import type { ServiceSchedule, ServiceWindow } from '@/lib/service-hours'

export const SCHEDULING_MODES = ['FIXED', 'ON_DEMAND'] as const

const HM_RE = /^(\d{1,2}):(\d{2})$/

function validHM(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = HM_RE.exec(s.trim())
  if (!m) return false
  const h = Number(m[1]); const min = Number(m[2])
  return h >= 0 && h <= 23 && min >= 0 && min <= 59
}

function normalizeWindow(raw: unknown): ServiceWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const label = typeof w.label === 'string' ? w.label.trim() : ''
  if (!label) return null
  if (!validHM(w.start) || !validHM(w.end)) return null
  return { label, start: (w.start as string).trim(), end: (w.end as string).trim() }
}

/**
 * Returns a clean ServiceSchedule (keys "0".."6", windows sorted by start) or
 * null. Drops invalid windows and empty days. Throws Error('bad-schedule') only
 * on a non-object top-level value.
 */
export function normalizeSchedule(raw: unknown): ServiceSchedule | null {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad-schedule')
  const out: ServiceSchedule = {}
  for (let idx = 0; idx < 7; idx++) {
    const key = String(idx)
    const dayRaw = (raw as Record<string, unknown>)[key]
    if (!Array.isArray(dayRaw)) continue
    const windows = dayRaw.map(normalizeWindow).filter((w): w is ServiceWindow => w !== null)
    windows.sort((a, b) => a.start.localeCompare(b.start))
    if (windows.length) out[key] = windows
  }
  return Object.keys(out).length ? out : null
}

export function normalizeMode(raw: unknown): 'FIXED' | 'ON_DEMAND' {
  return raw === 'ON_DEMAND' ? 'ON_DEMAND' : 'FIXED'
}

export function normalizePrepLead(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

/**
 * Build the persistable subset of scheduling fields from a request body.
 * `mode` ON_DEMAND forces serviceSchedule to null.
 */
export function buildScheduleFields(body: Record<string, unknown>): {
  schedulingMode: 'FIXED' | 'ON_DEMAND'
  prepLeadMinutes: number | null
  serviceSchedule: ServiceSchedule | null
} {
  const schedulingMode = normalizeMode(body.schedulingMode)
  const prepLeadMinutes = normalizePrepLead(body.prepLeadMinutes)
  const serviceSchedule = schedulingMode === 'ON_DEMAND'
    ? null
    : normalizeSchedule(body.serviceSchedule)
  return { schedulingMode, prepLeadMinutes, serviceSchedule }
}
