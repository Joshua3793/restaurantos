import { NextRequest, NextResponse } from 'next/server'
import { finalizeCountSession } from '@/lib/count-finalize'
import { invalidateTheoreticalCache } from '@/lib/theoretical-cache'

// POST /api/count/sessions/:id/finalize
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const result = await finalizeCountSession(params.id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  // A finalized count resets stock baselines — drop the theoretical-stock cache so the
  // prep list / cost strip reflect the new counts immediately (within this instance).
  invalidateTheoreticalCache()
  return NextResponse.json({ ok: true, summary: result.summary })
}
