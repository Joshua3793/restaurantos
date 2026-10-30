import 'server-only'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { CONFIRM_LIMIT, isLocked, LOCK_LIMIT, LOCK_WINDOW_MS } from '@/lib/pin/rules'
import { PinError } from '@/lib/pin/errors'

const PRUNE_AFTER_MS = 24 * 3600_000
/** About 1 in 50 recorded attempts also sweeps out rows older than a day. */
const PRUNE_CHANCE = 1 / 50

const TOO_MANY = 'Too many tries — wait 15 minutes'

/**
 * The caller's IP: first `x-vercel-forwarded-for` hop (set by Vercel's edge,
 * not spoofable there), else first `x-forwarded-for` hop, else `x-real-ip`,
 * else 'unknown'.
 */
export function clientIp(req: NextRequest): string {
  for (const header of ['x-vercel-forwarded-for', 'x-forwarded-for']) {
    const first = req.headers.get(header)?.split(',')[0]?.trim()
    if (first) return first
  }
  const real = req.headers.get('x-real-ip')?.trim()
  return real || 'unknown'
}

/** The per-IP key every "yes, that's me" confirm is recorded under. */
export function confirmKey(ip: string): string {
  return `confirm:ip:${ip}`
}

/**
 * Throws 429 when any key has hit its limit inside the window.
 *  - failure keys (`ip:…`, `cook:…`): LOCK_LIMIT rows with ok=false
 *  - confirm keys (`confirm:ip:…`):  CONFIRM_LIMIT rows with ok=true
 * Pass one kind per call.
 */
export async function checkLock(keys: string[]): Promise<void> {
  if (keys.length === 0) return
  const confirm = keys[0].startsWith('confirm:')
  if (keys.some((k) => k.startsWith('confirm:') !== confirm)) {
    throw new Error('[pin] checkLock: do not mix confirm and failure keys')
  }
  const now = new Date()
  const rows = await prisma.pinAttempt.findMany({
    where: { key: { in: keys }, ok: confirm, createdAt: { gt: new Date(now.getTime() - LOCK_WINDOW_MS) } },
    select: { key: true, createdAt: true },
  })
  const limit = confirm ? CONFIRM_LIMIT : LOCK_LIMIT
  for (const key of keys) {
    const at = rows.filter((r) => r.key === key).map((r) => r.createdAt)
    if (isLocked(at, now, limit)) throw new PinError(429, TOO_MANY)
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
