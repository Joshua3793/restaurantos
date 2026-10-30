import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { crewStatus, pinBlocked } from '@/lib/pin/crew-status'
import { PENDING_MAX_AGE_MS, pairCode, pinFullName } from '@/lib/pin/rules'

export const dynamic = 'force-dynamic'

const REJECTED_KEEP_MS = 30 * 24 * 60 * 60_000
const STATUS_ORDER = ['WAITING', 'NOT YET', 'NO PIN', 'SET UP', 'EMAIL LOGIN', 'SWITCHED OFF']

/**
 * GET — phones waiting for approval, and every active cook's sign-in status.
 * MANAGER+. Cooks have no revenue center, so there is no RC scoping here: a
 * manager sees every active cook. tokenHash is read only to derive each
 * phone's pair code and `sharedWith`; it is never returned.
 *
 * `sharedWith` (on each pending item and crew device): full names of the
 * OTHER cooks with an APPROVED or PENDING request from the same phone, so a
 * manager notices when the phone asking for Sam already signs in as Alex.
 * `stale` (pending items): older than PENDING_MAX_AGE_MS, so it can't be
 * OK'd until the cook asks again from their phone.
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
        user: { select: { role: true, isActive: true, email: true } },
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

    // Phone (token hash) → the cooks holding a live request or approval on it.
    const holders = new Map<string, Map<string, string>>()
    for (const c of cooks) {
      const name = pinFullName(c)
      for (const d of c.pinDevices) {
        if (d.status !== 'APPROVED' && d.status !== 'PENDING') continue
        const m = holders.get(d.tokenHash) ?? new Map<string, string>()
        m.set(c.id, name)
        holders.set(d.tokenHash, m)
      }
    }
    const sharedWith = (tokenHash: string, cookId: string): string[] =>
      [...(holders.get(tokenHash) ?? new Map<string, string>()).entries()]
        .filter(([id]) => id !== cookId)
        .map(([, n]) => n)
        .sort((a, b) => a.localeCompare(b))

    const staleBefore = Date.now() - PENDING_MAX_AGE_MS
    const pending: Array<{
      id: string
      cookName: string
      label: string | null
      createdAt: Date
      pairCode: string
      sharedWith: string[]
      stale: boolean
    }> = []
    const crew = cooks.map((c) => {
      const devices = [...c.pinDevices].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      const name = pinFullName(c)
      // A manager or a cook with an email login signs in with email, and a
      // switched-off login can't sign in at all: no phone of theirs is waiting
      // on anyone, so keep them out of `pending`.
      const blocked = pinBlocked(c.id, c.user)
      for (const d of devices) {
        if (!blocked && d.status === 'PENDING') {
          pending.push({
            id: d.id,
            cookName: name,
            label: d.label,
            createdAt: d.createdAt,
            pairCode: pairCode(d.tokenHash),
            sharedWith: sharedWith(d.tokenHash, c.id),
            stale: d.createdAt.getTime() < staleBefore,
          })
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
          sharedWith: sharedWith(d.tokenHash, c.id),
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
