import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export function validateTimeMinutes(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1439) {
    return 'timeMinutes must be an integer between 0 and 1439'
  }
  return null
}

// ── GET /api/services?revenueCenterId=<id> ────────────────────────────────────
// Returns that RC's services ordered by sortOrder, timeMinutes.
export async function GET(req: NextRequest) {
  try {
    await requireSession()

    const { searchParams } = new URL(req.url)
    const revenueCenterId = searchParams.get('revenueCenterId')
    if (!revenueCenterId) {
      return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })
    }

    const services = await prisma.service.findMany({
      where: { revenueCenterId },
      orderBy: [{ sortOrder: 'asc' }, { timeMinutes: 'asc' }],
    })

    return NextResponse.json(services)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[services GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST /api/services ─────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    await requireSession('ADMIN')

    const body = await req.json().catch(() => ({}))
    const { revenueCenterId, name, timeMinutes, endMinutes, sortOrder } = body

    if (!revenueCenterId || typeof revenueCenterId !== 'string') {
      return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })
    }
    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    const timeErr = validateTimeMinutes(timeMinutes)
    if (timeErr) return NextResponse.json({ error: timeErr }, { status: 400 })
    if (endMinutes !== undefined && endMinutes !== null) {
      const endErr = validateTimeMinutes(endMinutes)
      if (endErr) return NextResponse.json({ error: endErr.replace('timeMinutes', 'endMinutes') }, { status: 400 })
    }

    const rc = await prisma.revenueCenter.findUnique({ where: { id: revenueCenterId } })
    if (!rc) return NextResponse.json({ error: 'revenueCenter not found' }, { status: 400 })

    const service = await prisma.service.create({
      data: {
        revenueCenterId,
        name: name.trim(),
        timeMinutes,
        endMinutes: endMinutes ?? null,
        sortOrder: typeof sortOrder === 'number' && Number.isInteger(sortOrder) ? sortOrder : 0,
      },
    })

    return NextResponse.json(service, { status: 201 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[services POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
