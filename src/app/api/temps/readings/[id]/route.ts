import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// ── DELETE /api/temps/readings/[id] ───────────────────────────────────────────
// Remove a single mistaken reading (chip ✕ in the UI). LEAD+ — a food-safety
// record a cook can't quietly erase.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    await requireSession('LEAD')
    // deleteMany: a reading already gone (double tap, another device) is not an error.
    await prisma.tempReading.deleteMany({ where: { id: params.id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[temps/readings DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
