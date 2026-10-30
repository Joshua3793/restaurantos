import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { canSignOff, runProgress } from '@/lib/checklists/rules'
import { loadRunView } from '@/lib/checklists/runs'
import { whoOf } from '@/lib/checklists/cook-view'

export const dynamic = 'force-dynamic'

const NOTE_MAX = 1000

/**
 * POST { handoverNote? } — sign off one station's run. Needs every
 * before-doors / before-you-leave job answered (flagged counts as answered).
 * The note is kept for closing runs only and shows on the next opening.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession()
    const run = await prisma.checklistRun.findUnique({
      where: { id: params.id },
      include: {
        station: { select: { revenueCenterId: true, isShared: true } },
        lines: { select: { status: true, isBlocker: true } },
      },
    })
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    await assertRcWritable(user, run.station.revenueCenterId)

    if (run.station.isShared) {
      return NextResponse.json({ error: 'The whole-kitchen list has no sign-off' }, { status: 409 })
    }
    if (run.status === 'SIGNED') return NextResponse.json({ error: 'Already signed off' }, { status: 409 })
    if (run.lines.length === 0) return NextResponse.json({ error: 'Nothing to sign off' }, { status: 409 })
    if (!canSignOff(run.lines)) {
      const n = runProgress(run.lines).blockersLeft
      const s = n === 1 ? '' : 's'
      const error = run.phase === 'OPEN' ? `${n} before-doors job${s} left` : `${n} job${s} left before you leave`
      return NextResponse.json({ error }, { status: 409 })
    }

    const body = await req.json().catch(() => null)
    let handoverNote: string | null | undefined
    if (run.phase === 'CLOSE') {
      const note = typeof body?.handoverNote === 'string' ? body.handoverNote.trim() : ''
      if (note.length > NOTE_MAX) {
        return NextResponse.json({ error: `Note is too long (${NOTE_MAX} characters max)` }, { status: 400 })
      }
      handoverNote = note || null
    }

    const who = whoOf(user)
    await prisma.checklistRun.update({
      where: { id: run.id },
      data: {
        status: 'SIGNED',
        signedOffById: who.id,
        signedOffByName: who.name,
        signedOffAt: new Date(),
        ...(handoverNote !== undefined ? { handoverNote } : {}),
      },
    })
    return NextResponse.json({ run: await loadRunView(run.id) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/checklists/runs/[id]/signoff', e)
    return NextResponse.json({ error: 'Failed to sign off' }, { status: 500 })
  }
}
