/**
 * TipSettings singleton: defaults, the Decimal/Json → DTO mapper, and the
 * load-or-create reader. Lives here (not in the route file) because
 * Next.js App Router route.ts files may only export HTTP method handlers
 * and the small config allow-list (`dynamic`, `revalidate`, …) — any other
 * export fails the route-type check at build time. Both
 * `src/app/api/tips/settings/route.ts` and `src/app/api/tips/roster/route.ts`
 * import from here.
 */
import 'server-only'
import { prisma } from '@/lib/prisma'
import type { TipSettings } from '@prisma/client'

export const DEFAULTS = {
  id: 'singleton',
  poolBasis: 'NET_SALES',
  includeAutoGratuity: true,
  poolRatePct: 5,
  defaultDailyHourCap: null,
  rewardTiers: [1.25, 1.5, 2],
  roundingStepCents: 100,
  periodDays: 14,
  periodStartDow: 0,
  salesSourceMode: 'LOCATION',
  salesLocationId: null,
  salesRcIds: [],
  poolRevenueCenterId: null,
  poolDepartments: ['Back of House'],
  posMap: {},
  denoms: [
    { v: 10000, l: '$100', on: false }, { v: 5000, l: '$50', on: true },
    { v: 2000, l: '$20', on: true }, { v: 1000, l: '$10', on: true },
    { v: 500, l: '$5', on: true }, { v: 200, l: '$2', on: true },
    { v: 100, l: '$1', on: true }, { v: 25, l: '25¢', on: true },
    { v: 10, l: '10¢', on: true }, { v: 5, l: '5¢', on: true },
  ],
}

/** Prisma Decimal → number, Json → typed. Every response goes through this. */
export function toDto(s: TipSettings) {
  return {
    poolBasis: s.poolBasis as 'NET_SALES' | 'TIPS_COLLECTED',
    includeAutoGratuity: s.includeAutoGratuity,
    poolRatePct: Number(s.poolRatePct),
    defaultDailyHourCap: s.defaultDailyHourCap == null ? null : Number(s.defaultDailyHourCap),
    rewardTiers: s.rewardTiers as number[],
    roundingStepCents: s.roundingStepCents,
    periodDays: s.periodDays,
    periodStartDow: s.periodStartDow,
    salesSourceMode: s.salesSourceMode,
    salesLocationId: s.salesLocationId,
    salesRcIds: s.salesRcIds as string[],
    poolRevenueCenterId: s.poolRevenueCenterId,
    poolDepartments: s.poolDepartments as string[],
    posMap: s.posMap as Record<string, string>,
    denoms: s.denoms as Array<{ v: number; l: string; on: boolean }>,
  }
}

/** Reads the singleton, creating it with defaults the first time. */
export async function loadSettings(): Promise<TipSettings> {
  const existing = await prisma.tipSettings.findUnique({ where: { id: 'singleton' } })
  if (existing) return existing
  return prisma.tipSettings.create({ data: DEFAULTS })
}
