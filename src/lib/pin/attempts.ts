import 'server-only'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isLocked, LOCK_WINDOW_MS } from '@/lib/pin/rules'
import { PinError } from '@/lib/pin/errors'

const PRUNE_AFTER_MS = 24 * 3600_000
/** About 1 in 50 recorded attempts also sweeps out rows older than a day. */
const PRUNE_CHANCE = 1 / 50

/** The caller's IP: first `x-forwarded-for` hop, else `x-real-ip`, else 'unknown'. */
export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  const real = req.headers.get('x-real-ip')?.trim()
  return real || 'unknown'
}

/** Throws 429 when any key has LOCK_LIMIT failed tries inside the window. */
export async function checkLock(keys: string[]): Promise<void> {
  if (keys.length === 0) return
  const now = new Date()
  const rows = await prisma.pinAttempt.findMany({
    where: { key: { in: keys }, ok: false, createdAt: { gt: new Date(now.getTime() - LOCK_WINDOW_MS) } },
    select: { key: true, createdAt: true },
  })
  for (const key of keys) {
    const failedAt = rows.filter((r) => r.key === key).map((r) => r.createdAt)
    if (isLocked(failedAt, now)) throw new PinError(429, 'Too many tries — wait 15 minutes')
  }
}

/** One row per key. Now and then also deletes rows older than 24 hours. */
export async function recordAttempt(keys: string[], ok: boolean): Promise<void> {
  if (keys.length === 0) return
  await prisma.pinAttempt.createMany({ data: keys.map((key) => ({ key, ok })) })
  if (Math.random() < PRUNE_CHANCE) {
    try {
      await prisma.pinAttempt.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - PRUNE_AFTER_MS) } } })
    } catch {
      console.error('[pin] could not prune old PIN attempts')
    }
  }
}
