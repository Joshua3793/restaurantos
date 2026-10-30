import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

const TRANSITIONS = {
  approve: { from: 'PENDING', to: 'APPROVED' },
  reject: { from: 'PENDING', to: 'REJECTED' },
  revoke: { from: 'APPROVED', to: 'REVOKED' },
} as const

type Action = keyof typeof TRANSITIONS

function isAction(v: unknown): v is Action {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TRANSITIONS, v)
}

/**
 * PATCH { action: 'approve' | 'reject' | 'revoke' } — MANAGER+.
 *
 * Each move is a guarded updateMany on the expected current status, so two
 * managers tapping at once cannot both win (the loser gets 409).
 *
 * Revoke stops this phone signing in AGAIN. It does not end a session that is
 * already open on the phone: to lock someone out right now, switch off their
 * login in People (which deactivates both the Prisma and Supabase user).
 *
 * Reject and revoke leave approvedById/Name/At untouched, for history.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const user = await requireSession('MANAGER')

    const body = (await req.json().catch(() => null)) as { action?: unknown } | null
    const action = body?.action
    if (!isAction(action)) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

    const device = await prisma.pinDevice.findUnique({ where: { id: params.id }, select: { id: true } })
    if (!device) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { from, to } = TRANSITIONS[action]
    const data =
      action === 'approve'
        ? {
            status: to,
            approvedById: user.id,
            approvedByName: user.name?.trim() || user.email.split('@')[0],
            approvedAt: new Date(),
          }
        : { status: to }

    const { count } = await prisma.pinDevice.updateMany({ where: { id: params.id, status: from }, data })
    if (count === 0) return NextResponse.json({ error: 'Already handled' }, { status: 409 })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/pin-devices/[id]', e)
    return NextResponse.json({ error: 'Failed to update the phone' }, { status: 500 })
  }
}
