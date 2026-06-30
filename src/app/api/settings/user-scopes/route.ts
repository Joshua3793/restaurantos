import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * ADMIN-only API to read and replace a user's RC/location scope assignments.
 *
 * A UserScope row assigns a user to EITHER a location (all its RCs) OR a single
 * RC — exactly one of locationId/revenueCenterId is set per row. No rows (or
 * ADMIN) means unrestricted (see resolveScopedRcIds in src/lib/rc-scope.ts).
 */

// GET /api/settings/user-scopes?userId=...
export async function GET(req: NextRequest) {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const scopes = await prisma.userScope.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(scopes)
}

type IncomingScope = { locationId?: string | null; revenueCenterId?: string | null }

// PUT /api/settings/user-scopes — replace a user's full scope set
export async function PUT(req: NextRequest) {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = (await req.json().catch(() => null)) as {
    userId?: string
    scopes?: IncomingScope[]
  } | null

  const userId = body?.userId
  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const incoming = Array.isArray(body?.scopes) ? body!.scopes : []

  // user must exist
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // validate + collect referenced ids
  const locationIds = new Set<string>()
  const rcIds = new Set<string>()
  for (const s of incoming) {
    const hasLoc = !!s.locationId
    const hasRc = !!s.revenueCenterId
    if (hasLoc === hasRc) {
      // both set or both null/empty
      return NextResponse.json(
        { error: 'each scope must target exactly one location or revenue center' },
        { status: 400 },
      )
    }
    if (hasLoc) locationIds.add(s.locationId as string)
    if (hasRc) rcIds.add(s.revenueCenterId as string)
  }

  // referenced ids must exist
  if (locationIds.size > 0) {
    const found = await prisma.location.findMany({
      where: { id: { in: [...locationIds] } },
      select: { id: true },
    })
    if (found.length !== locationIds.size) {
      return NextResponse.json(
        { error: 'one or more referenced locations do not exist' },
        { status: 400 },
      )
    }
  }
  if (rcIds.size > 0) {
    const found = await prisma.revenueCenter.findMany({
      where: { id: { in: [...rcIds] } },
      select: { id: true },
    })
    if (found.length !== rcIds.size) {
      return NextResponse.json(
        { error: 'one or more referenced revenue centers do not exist' },
        { status: 400 },
      )
    }
  }

  // dedup by (locationId, revenueCenterId) target so the same node isn't
  // inserted twice (the Prisma @@unique doesn't block NULL-bearing dups —
  // the DB-level NULLS NOT DISTINCT index is the real guard).
  const seen = new Set<string>()
  const dedupedRows = incoming
    .map((r) => ({
      locationId: r.locationId ?? null,
      revenueCenterId: r.revenueCenterId ?? null,
    }))
    .filter((r) => {
      const key = `${r.locationId ?? ''}|${r.revenueCenterId ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  // replace the user's full scope set transactionally
  await prisma.$transaction([
    prisma.userScope.deleteMany({ where: { userId } }),
    prisma.userScope.createMany({
      data: dedupedRows.map((r) => ({
        userId,
        locationId: r.locationId,
        revenueCenterId: r.revenueCenterId,
      })),
    }),
  ])

  const scopes = await prisma.userScope.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(scopes)
}
