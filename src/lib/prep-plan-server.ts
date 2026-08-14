import { prisma } from '@/lib/prisma'

/** Same day convention as every PrepLog write: server-local midnight. */
export function prepDayStart(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

export function prepDayRange(): { gte: Date; lt: Date } {
  const gte = prepDayStart()
  return { gte, lt: new Date(gte.getTime() + 86_400_000) }
}

/**
 * A draft edit after posting means the kitchen is looking at a stale list —
 * flag today's post(s) so both surfaces can say "CHEF HAS UNPOSTED CHANGES".
 * rcId null (a Shared item) can sit on any RC's plan → flag all of today's posts.
 */
export async function markPlanDirty(rcId: string | null): Promise<void> {
  const listDate = prepDayStart()
  await prisma.prepPost.updateMany({
    where: rcId ? { revenueCenterId: rcId, listDate } : { listDate },
    data: { dirty: true },
  })
}
