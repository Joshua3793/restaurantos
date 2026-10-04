import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { undoRemeasure, RemeasureRefusal } from '@/lib/remeasure-exec'
import { refusalResponse } from '@/lib/remeasure-status'

export const dynamic = 'force-dynamic'
// Replays the manifest inside one transaction, then re-costs the recipes.
export const maxDuration = 300

// POST /api/inventory/remeasures/:id/undo → replay a measure change backwards.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  try {
    await undoRemeasure(params.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof RemeasureRefusal) return refusalResponse(e)
    console.error('[remeasure] undo failed', e)
    return NextResponse.json({ error: 'The undo could not be completed. Nothing was changed.' }, { status: 500 })
  }
}
