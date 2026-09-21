import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { undoMerge } from '@/lib/item-merge-exec'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/inventory/merges/:id/undo → replay the manifest backwards.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  try {
    const r = await undoMerge(params.id)
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status })
  } catch (e) {
    console.error('[merge] undo failed', e)
    return NextResponse.json({ error: 'The undo could not be completed. Nothing was changed.' }, { status: 500 })
  }
}
