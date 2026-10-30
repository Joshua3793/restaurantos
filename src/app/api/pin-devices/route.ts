import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { atLeast } from '@/lib/roles'
import { crewStatus, type Blocked } from '@/lib/pin/crew-status'
import { pairCode, pinFullName } from '@/lib/pin/rules'

export const dynamic = 'force-dynamic'

const REJECTED_KEEP_MS = 30 * 24 * 60 * 60_000
const STATUS_ORDER = ['WAITING', 'NOT YET', 'NO PIN', 'SET UP', 'EMAIL LOGIN', 'SWITCHED OFF']

/**
 * GET — phones waiting for approval, and every active cook's sign-in status.
 * MANAGER+. Cooks have no revenue center, so there is no RC scoping here: a
 * manager sees every active cook. tokenHash is read only to derive each
 * phone's pair code; it is never returned.
 */
export async function GET() {
  try {
    await requireSession('MANAGER')

    // One query: cooks with their (recent) phones. Pending is derived from it.
    const cooks = await prisma.cook.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        lastName: true,
        homeStation: true,
        clockId: true,
        sortOrder: true,
        user: { select: { role: true, isActive: true } },
        pinDevices: {
          where: {
            NOT: { status: 'REJECTED', createdAt: { lt: new Date(Date.now() - REJECTED_KEEP_MS) } },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, label: true, status: true, createdAt: true, lastUsedAt: true, approvedByName: true, tokenHash: true,
          },
        },
      },
    })

    const pending: Array<{ id: string; cookName: string; label: string | null; createdAt: Date; pairCode: string }> = []
    const crew = cooks.map((c) => {
      const devices = [...c.pinDevices].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      const name = pinFullName(c)
      // A manager signs in with email, and a switched-off login can't sign in at
      // all: no phone of theirs is waiting on anyone, so keep them out of `pending`.
      const blocked: Blocked | null = !c.user
        ? null
        : atLeast(c.user.role, 'MANAGER')
          ? 'MANAGER'
          : !c.user.isActive
            ? 'SWITCHED_OFF'
            : null
      for (const d of devices) {
        if (!blocked && d.status === 'PENDING') {
          pending.push({ id: d.id, cookName: name, label: d.label, createdAt: d.createdAt, pairCode: pairCode(d.tokenHash) })
        }
      }
      return {
        cookId: c.id,
        name,
        station: c.homeStation,
        status: crewStatus(c, devices, blocked),
        blocked,
        devices: devices.map((d) => ({
          id: d.id,
          label: d.label,
          status: d.status,
          createdAt: d.createdAt,
          lastUsedAt: d.lastUsedAt,
          approvedByName: d.approvedByName,
          pairCode: pairCode(d.tokenHash),
        })),
        sortOrder: c.sortOrder,
      }
    })

    pending.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    crew.sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status.label) - STATUS_ORDER.indexOf(b.status.label) ||
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name),
    )

    return NextResponse.json({
      pending,
      crew: crew.map(({ sortOrder: _sortOrder, ...rest }) => rest),
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/pin-devices', e)
    return NextResponse.json({ error: 'Failed to load crew sign-in' }, { status: 500 })
  }
}
