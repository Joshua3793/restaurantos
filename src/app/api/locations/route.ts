import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveScopedRcIds } from '@/lib/rc-scope'
import { RC_COLORS } from '@/lib/rc-colors'
import { ACTIVE_SERVICES_INCLUDE, normalizePrepLead } from '@/lib/rc-service-select'
import { User } from '@prisma/client'

export const dynamic = 'force-dynamic'

const LOCATION_TYPES = ['restaurant', 'catering', 'other'] as const

export async function GET() {
  let user: User
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const allowed = await resolveScopedRcIds(user)

  const locations = await prisma.location.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      revenueCenters: {
        orderBy: { createdAt: 'asc' },
        include: {
          services: ACTIVE_SERVICES_INCLUDE,
        },
      },
    },
  })

  const filtered = allowed === null
    ? locations
    : locations
        .map(l => ({ ...l, revenueCenters: l.revenueCenters.filter(rc => allowed.has(rc.id)) }))
        .filter(l => l.revenueCenters.length > 0)

  return NextResponse.json(filtered)
}

export async function POST(req: NextRequest) {
  let user: User
  try { user = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  void user

  const body = await req.json().catch(() => ({}))
  const { name, color, type, isDefault, isActive, description, managerName, notes, defaultRevenueCenterId } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  // A brand-new location has no revenue centers yet, so a non-null default
  // can't belong to it. The default is set later via PATCH once RCs exist.
  if (defaultRevenueCenterId) {
    return NextResponse.json({ error: 'default revenue center must belong to this location' }, { status: 400 })
  }

  const resolvedColor = RC_COLORS.includes(color) ? color : 'blue'
  const resolvedType  = LOCATION_TYPES.includes(type) ? type : 'restaurant'

  const prepLeadMinutes = normalizePrepLead(body.prepLeadMinutes)

  const loc = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.location.updateMany({ data: { isDefault: false } })
    }
    return tx.location.create({
      data: {
        name: name.trim(),
        color: resolvedColor,
        type: resolvedType,
        isDefault: !!isDefault,
        isActive:  isActive !== undefined ? !!isActive : true,
        description: description || null,
        managerName: managerName || null,
        notes:       notes || null,
        prepLeadMinutes,
      },
    })
  })

  return NextResponse.json(loc, { status: 201 })
}
