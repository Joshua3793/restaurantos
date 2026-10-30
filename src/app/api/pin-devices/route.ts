import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { crewStatus } from '@/lib/pin/crew-status'

export const dynamic = 'force-dynamic'

const REJECTED_KEEP_MS = 30 * 24 * 60 * 60_000
const STATUS_ORDER = ['WAITING', 'NOT YET', 'NO PIN', 'SET UP']

function fullName(c: { name: string; lastName: string | null }): string {
  const last = c.lastName?.trim()
  const first = c.name.trim()
  return last && !first.toLowerCase().endsWith(last.toLowerCase()) ? `${first} ${last}` : first
}

/**
 * GET — phones waiting for approval, and every active cook's sign-in status.
 * MANAGER+. Cooks have no revenue center, so there is no RC scoping here: a
 * manager sees every active cook. tokenHash is never selected.
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
        pinDevices: {
          where: {
            NOT: { status: 'REJECTED', createdAt: { lt: new Date(Date.now() - REJECTED_KEEP_MS) } },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, label: true, status: true, createdAt: true, lastUsedAt: true, approvedByName: true },
        },
      },
    })

    const pending: Array<{ id: string; cookName: string; label: string | null; createdAt: Date }> = []
    const crew = cooks.map((c) => {
      const devices = [...c.pinDevices].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      const name = fullName(c)
      for (const d of devices) {
        if (d.status === 'PENDING') pending.push({ id: d.id, cookName: name, label: d.label, createdAt: d.createdAt })
      }
      return {
        cookId: c.id,
        name,
        station: c.homeStation,
        status: crewStatus(c, devices),
        devices: devices.map((d) => ({
          id: d.id,
          label: d.label,
          status: d.status,
          lastUsedAt: d.lastUsedAt,
          approvedByName: d.approvedByName,
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
