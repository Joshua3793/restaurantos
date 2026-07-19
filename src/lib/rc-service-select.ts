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
