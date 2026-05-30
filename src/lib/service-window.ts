export interface ServiceWindow { startHHMM: string; prepLeadMinutes: number } // e.g. { startHHMM: '17:00', prepLeadMinutes: 150 }

export interface ServiceCountdown { serviceLabel: string; minsToService: number; startByHHMM: string }

/** Returns null if no usable service window (feature not yet modeled / RC has none). */
export function computeServiceCountdown(win: Partial<ServiceWindow> | null | undefined, now: Date = new Date()): ServiceCountdown | null {
  if (!win?.startHHMM) return null
  const [h, m] = win.startHHMM.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  const svc = new Date(now); svc.setHours(h, m, 0, 0)
  const minsToService = Math.round((svc.getTime() - now.getTime()) / 60_000)
  if (minsToService < 0) return null // service already started/passed today
  const lead = win.prepLeadMinutes ?? 0
  const startBy = new Date(svc.getTime() - lead * 60_000)
  const startByHHMM = `${String(startBy.getHours()).padStart(2,'0')}:${String(startBy.getMinutes()).padStart(2,'0')}`
  const hh = Math.floor(minsToService / 60), mm = minsToService % 60
  return { serviceLabel: hh > 0 ? `${hh}h ${mm}m` : `${mm}m`, minsToService, startByHHMM }
}
