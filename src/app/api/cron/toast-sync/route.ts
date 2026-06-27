import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { runToastSync, runToastBackfill } from '@/lib/toast/sales-sync'

export const dynamic = 'force-dynamic'
// Pulling + writing a day can exceed the default budget on a busy date / backfill.
export const maxDuration = 300

/**
 * GET /api/cron/toast-sync — nightly Toast sales sync.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` (set the env var
 * to enable). Manual/backfill runs from the app fall back to an ADMIN session.
 *
 * Query params (manual/backfill):
 *   ?date=YYYYMMDD            sync one specific business day
 *   ?from=YYYYMMDD&to=YYYYMMDD  backfill an inclusive range
 *   (none)                    sync yesterday (LA-local)
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  const cronOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
  if (!cronOk) {
    try {
      await requireSession('ADMIN')
    } catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  const sp = req.nextUrl.searchParams
  const date = sp.get('date')
  const from = sp.get('from')
  const to = sp.get('to')

  try {
    if (from && to) {
      const results = await runToastBackfill(Number(from), Number(to))
      return NextResponse.json({ mode: 'backfill', days: results.length, results })
    }
    const result = await runToastSync(date ? Number(date) : undefined)
    return NextResponse.json({ mode: 'day', result })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
