/**
 * The one shape every endpoint uses to return a revenue center's services.
 *
 * Active-only is load-bearing: consumers type these as `RcService`
 * (src/lib/service-hours.ts), which deliberately has no `isActive` field because
 * the API pre-filters. Inactive services may carry `endMinutes: null` (hours
 * unknown) and must never reach a consumer.
 *
 * Keep the selected fields identical to `RcService`.
 */
import { Prisma } from '@prisma/client'

export const ACTIVE_SERVICES_INCLUDE: Prisma.RevenueCenter$servicesArgs = {
  where: { isActive: true },
  orderBy: [{ sortOrder: 'asc' }, { timeMinutes: 'asc' }],
  select: { id: true, name: true, timeMinutes: true, endMinutes: true },
}

// prepLeadMinutes is the only scheduling field left on Location/RevenueCenter
// that the app still writes — service type + hours now live on Service rows
// instead. Shared by the locations and revenue-centers route handlers.
export function normalizePrepLead(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}
