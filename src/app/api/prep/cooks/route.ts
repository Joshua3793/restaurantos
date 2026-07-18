import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function normalizeInitials(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.trim().toUpperCase().slice(0, 3)
}

// ── GET /api/prep/cooks ─────────────────────────────────────────────────────
// Default: active cooks only, ordered by sortOrder, name — this is what
// /api/prep/items and every other consumer relies on. Pass
// ?includeInactive=true (used by the Kitchen Crew admin page) to also see
// deactivated cooks, so they can be reactivated — sorted active-first.
export async function GET(req: NextRequest) {
  try {
    await requireSession()

    const includeInactive = req.nextUrl.searchParams.get('includeInactive') === 'true'

    const cooks = await prisma.cook.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: includeInactive
        ? [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }]
        : [{ sortOrder: 'asc' }, { name: 'asc' }],
    })

    return NextResponse.json(cooks)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[prep/cooks GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST /api/prep/cooks ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    await requireSession('ADMIN')

    const body = await req.json().catch(() => ({}))
    const { name, initials, homeStation, sortOrder } = body

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    const normalizedInitials = normalizeInitials(initials)
    if (!normalizedInitials) {
      return NextResponse.json({ error: 'initials is required' }, { status: 400 })
    }

    if (homeStation !== undefined && homeStation !== null && typeof homeStation !== 'string') {
      return NextResponse.json({ error: 'homeStation must be a string' }, { status: 400 })
    }

    const cook = await prisma.cook.create({
      data: {
        name: name.trim(),
        initials: normalizedInitials,
        homeStation: typeof homeStation === 'string' ? homeStation.trim() || null : null,
        sortOrder: typeof sortOrder === 'number' && Number.isInteger(sortOrder) ? sortOrder : 0,
      },
    })

    return NextResponse.json(cook, { status: 201 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[prep/cooks POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
