import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { loadRollbackInputs } from '@/lib/invoice/rollback-load'
import { planRollback } from '@/lib/invoice/rollback'

// A GET handler with no dynamic API usage is prerendered at build time, which
// would serve a plan computed against the build's database — i.e. a lie about
// what a delete is going to do right now.
export const dynamic = 'force-dynamic'

// GET /api/invoices/sessions/[id]/delete-plan
// What deleting this session WOULD do: the same loader and the same planner the
// DELETE runs, with nothing applied. Read-only, so any signed-in user may look —
// the MANAGER gate is on the delete itself, not on seeing what it costs.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const loaded = await loadRollbackInputs(prisma, params.id)
  if (!loaded) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const plan = planRollback(loaded.input)

  return NextResponse.json(
    {
      legacy: plan.legacy,
      rows: plan.rows,
      summary: plan.summary,
      // An RC copy cannot be deleted on its own — the UI greys the button and
      // shows the 409's message as the tooltip.
      isClone: loaded.session.parentSessionId !== null,
    },
    // The plan is a live read of rows anyone can be editing; a cached preview
    // would promise a rollback the delete then refuses.
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
