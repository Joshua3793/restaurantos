import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { pinBlocked } from '@/lib/pin/crew-status'
import { PENDING_MAX_AGE_MS } from '@/lib/pin/rules'

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
 * Revoke stops this phone signing in again, and (RULING P9) requireSession
 * refuses a PIN login's API calls from a phone that is no longer APPROVED, so
 * it takes effect on the next request. Pages already loaded stay on screen
 * until they next fetch; switching the login off in People still ends it all.
 *
 * Approve refuses a phone the cook could never use (manager, switched-off login
 * or cook) and a request more than 24 h old: PATCH is the only way a phone gets
 * approved, so it must not hand out approvals that can never sign in.
 * Reject and revoke leave approvedById/Name/At untouched, for history.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const user = await requireSession('MANAGER')

    const body = (await req.json().catch(() => null)) as { action?: unknown } | null
    const action = body?.action
    if (!isAction(action)) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

    const device = await prisma.pinDevice.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        status: true,
        createdAt: true,
        cook: { select: { id: true, isActive: true, user: { select: { role: true, isActive: true, email: true } } } },
      },
    })
    if (!device) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Only a still-PENDING request is checked here; anything else falls through
    // to the guarded updateMany, which answers 'Already handled'.
    if (action === 'approve' && device.status === 'PENDING') {
      const refuse = (error: string) => NextResponse.json({ error }, { status: 409 })
      const blocked = pinBlocked(device.cook.id, device.cook.user)
      if (blocked === 'MANAGER') return refuse('Managers sign in with email and password')
      if (blocked === 'SWITCHED_OFF') return refuse('This login is switched off')
      if (blocked === 'EMAIL_LOGIN') return refuse('This cook has an email login — they sign in with email and password')
      if (!device.cook.isActive) return refuse('This cook is switched off')
      if (Date.now() - device.createdAt.getTime() > PENDING_MAX_AGE_MS) {
        return refuse('This request is too old — ask them to try again on their phone')
      }
    }

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
