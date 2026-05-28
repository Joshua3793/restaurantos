import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { evaluateAllRules } from '@/lib/signals/rules'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/signals/refresh
 *
 * Re-evaluates all rules and upserts results into the Signal table.
 * Triggered by:
 *  - Manual "Refresh" button on the Signals page
 *  - Cron (Phase 9 will wire scheduled refresh)
 *
 * Re-runs are safe: each candidate has a stable fingerprint that uniquely
 * identifies the underlying condition. Existing OPEN signals get their
 * fields refreshed; resolved candidates are pruned.
 */
export async function POST() {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const candidates = await evaluateAllRules()
  const fingerprints = new Set(candidates.map(c => c.fingerprint))

  // Upsert each candidate
  let inserted = 0, updated = 0
  for (const c of candidates) {
    const existing = await prisma.signal.findUnique({ where: { fingerprint: c.fingerprint } })
    if (existing) {
      // Don't disturb SNOOZED/DISMISSED state; only update OPEN/APPLIED metadata
      if (existing.status === 'SNOOZED' || existing.status === 'DISMISSED') continue
      await prisma.signal.update({
        where: { fingerprint: c.fingerprint },
        data: {
          rule: c.rule,
          severity: c.severity,
          title: c.title,
          body: c.body,
          verbLabel: c.verbLabel,
          verbHref: c.verbHref,
          impactValue: c.impactValue ?? 0,
          itemId: c.itemId ?? null,
          recipeId: c.recipeId ?? null,
        },
      })
      updated++
    } else {
      await prisma.signal.create({
        data: {
          fingerprint: c.fingerprint,
          rule: c.rule,
          severity: c.severity,
          title: c.title,
          body: c.body,
          verbLabel: c.verbLabel,
          verbHref: c.verbHref,
          impactValue: c.impactValue ?? 0,
          itemId: c.itemId ?? null,
          recipeId: c.recipeId ?? null,
          status: 'OPEN',
        },
      })
      inserted++
    }
  }

  // Prune resolved OPEN signals (no longer in candidates)
  const resolved = await prisma.signal.deleteMany({
    where: {
      status: 'OPEN',
      fingerprint: { notIn: Array.from(fingerprints) },
    },
  })

  return NextResponse.json({
    inserted, updated, resolved: resolved.count, total: candidates.length,
  })
}
