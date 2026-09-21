import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { undoMerge } from '@/lib/item-merge-exec'
import { invalidateTheoreticalCache } from '@/lib/theoretical-cache'

export const dynamic = 'force-dynamic'
// Replays the manifest inside one transaction (30 s budget) after a pre-check
// that re-reads three "since the merge" questions — 60 s left no headroom.
export const maxDuration = 120

// POST /api/inventory/merges/:id/undo → replay the manifest backwards.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  try {
    const r = await undoMerge(params.id)
    // An undo moves the same stock-moving rows back onto the absorbed item and
    // restores both items' stockOnHand — drop the theoretical cache, same as the
    // merge does.
    if (r.ok) invalidateTheoreticalCache()
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status })
  } catch (e) {
    console.error('[merge] undo failed', e)
    return NextResponse.json({ error: 'The undo could not be completed. Nothing was changed.' }, { status: 500 })
  }
}
