import { NextRequest, NextResponse } from 'next/server'
import { finalizeCountSession } from '@/lib/count-finalize'

// POST /api/count/sessions/:id/finalize
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const result = await finalizeCountSession(params.id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, summary: result.summary })
}
