// src/lib/service-hours.ts
// Pure helpers — no DB. Compute the next service window and prep deadline for a
// revenue center from its weekly service schedule. Day index: 0=Mon … 6=Sun.

export type ServiceWindow = { label: string; start: string; end: string } // start/end = "HH:MM"
export type ServiceSchedule = Record<string, ServiceWindow[]>             // keys "0".."6"

/** Minimal shape this lib needs from a revenue center. */
export interface SchedulableRc {
  schedulingMode: string                 // "FIXED" | "ON_DEMAND"
  prepLeadMinutes: number | null
  serviceSchedule: ServiceSchedule | null
}

/** Our Monday-first day index for a Date (0=Mon … 6=Sun). */
export function dayIndex(d: Date): number {
  return (d.getDay() + 6) % 7
}

function parseHM(hm: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!match) return null
  const h = Number(match[1]); const m = Number(match[2])
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return { h, m }
}

/** Windows for a given Monday-first day index, sorted by start time. */
function windowsForDay(rc: SchedulableRc, idx: number): ServiceWindow[] {
  const list = rc.serviceSchedule?.[String(idx)] ?? []
  return [...list].sort((a, b) => a.start.localeCompare(b.start))
}

function atTime(base: Date, hm: string): Date | null {
  const p = parseHM(hm)
  if (!p) return null
  const out = new Date(base)
  out.setHours(p.h, p.m, 0, 0)
  return out
}

/**
 * Next service window START strictly after `now`. Scans today's remaining
 * windows, then following days, wrapping up to 7 days. null for ON_DEMAND,
 * no schedule, or an entirely empty week.
 */
export function nextServiceStart(rc: SchedulableRc, now: Date): { start: Date; label: string } | null {
  if (rc.schedulingMode !== 'FIXED' || !rc.serviceSchedule) return null
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(now)
    day.setDate(now.getDate() + offset)
    const idx = dayIndex(day)
    for (const w of windowsForDay(rc, idx)) {
      const start = atTime(day, w.start)
      if (start && start.getTime() > now.getTime()) {
        return { start, label: w.label }
      }
    }
  }
  return null
}

/**
 * The window in progress right now (start <= now < end), if any. Windows whose
 * end <= start are treated as crossing midnight (end on the next day).
 */
export function currentWindow(rc: SchedulableRc, now: Date): { window: ServiceWindow; end: Date } | null {
  if (rc.schedulingMode !== 'FIXED' || !rc.serviceSchedule) return null
  // Check today and yesterday (a window started yesterday may still be running past midnight).
  for (let offset = -1; offset <= 0; offset++) {
    const day = new Date(now)
    day.setDate(now.getDate() + offset)
    const idx = dayIndex(day)
    for (const w of windowsForDay(rc, idx)) {
      const start = atTime(day, w.start)
      let end = atTime(day, w.end)
      if (!start || !end) continue
      if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 24 * 3_600_000)
      if (start.getTime() <= now.getTime() && now.getTime() < end.getTime()) {
        return { window: w, end }
      }
    }
  }
  return null
}

/** nextServiceStart minus the center's prep lead. null if no upcoming start. */
export function prepDeadline(rc: SchedulableRc, now: Date): Date | null {
  const next = nextServiceStart(rc, now)
  if (!next) return null
  const lead = rc.prepLeadMinutes ?? 0
  return new Date(next.start.getTime() - lead * 60_000)
}

/** "2h 30m", "45m", "1d 2h". Clamps negatives to "0m". */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMin = Math.floor(ms / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function fmtWindow(w: ServiceWindow): string {
  return `${w.start}–${w.end}`
}
