import { NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { runToastSync, laBusinessDateInt } from '@/lib/toast/sales-sync'

export const dynamic = 'force-dynamic'
// A busy day's pull can exceed the default budget.
export const maxDuration = 300

/**
 * POST /api/toast/sync-sales — on-demand pull of TODAY's Toast sales (the current
 * LA business date), so the whole system reflects the day-so-far without waiting
 * for the nightly cron.
 *
 * Safe to run repeatedly: `syncBusinessDay` is idempotent — it overwrites this
 * day's `source:'toast'` SalesEntry rows rather than accumulating, never touches
 * manual (`source:'manual'`) entries, and never writes stock or the spine.
 *
 * MANAGER+ (the nightly cron endpoint `/api/cron/toast-sync` stays ADMIN/secret).
 */
export async function POST() {
  try {
    await requireSession('MANAGER')
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  try {
    const today = laBusinessDateInt(new Date())
    const result = await runToastSync(today)
    return NextResponse.json({ result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
