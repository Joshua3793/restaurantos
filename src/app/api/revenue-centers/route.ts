import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { RC_COLORS } from '@/lib/rc-colors'
import { buildScheduleFields } from '@/lib/rc-schedule'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveScopedRcIds } from '@/lib/rc-scope'
import { User } from '@prisma/client'

const RC_LEAF_TYPES = ['FOOD', 'DRINK'] as const

export async function GET() {
  let user: User
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  let rcs = await prisma.revenueCenter.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      services: {
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { timeMinutes: 'asc' }],
        select: { id: true, name: true, timeMinutes: true, endMinutes: true },
      },
    },
  })

  if (rcs.length === 0) {
    // Bootstrap an empty DB: a RevenueCenter now requires a Location, so wrap
    // the default RC in a default Location.
    const defaultRc = await prisma.$transaction(async (tx) => {
      // Attach to an existing Location if one exists (prefer the default), so we
      // never create a SECOND isDefault Location. Only flag a freshly-created
      // Location as default when none exists at all.
      let loc =
        (await tx.location.findFirst({ where: { isDefault: true } })) ??
        (await tx.location.findFirst())
      if (!loc) {
        loc = await tx.location.create({
          data: { name: 'Main Kitchen', color: 'blue', isDefault: true },
        })
      }
      return tx.revenueCenter.create({
        data: { name: 'Main Kitchen', color: 'blue', isDefault: true, locationId: loc.id },
      })
    })
    // Freshly created — no services exist for it yet.
    rcs = [{ ...defaultRc, services: [] }]
  }

  const allowed = await resolveScopedRcIds(user)
  if (allowed !== null) {
    rcs = rcs.filter(rc => allowed.has(rc.id))
  }

  return NextResponse.json(rcs)
}

export async function POST(req: NextRequest) {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({}))
  const { name, color, isDefault, isActive, type, locationId, description, managerName, targetCostPct, targetFoodCostPct, notes } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  if (!locationId || (typeof locationId === 'string' && !locationId.trim())) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 })
  }
  const loc = await prisma.location.findUnique({ where: { id: locationId } })
  if (!loc) {
    return NextResponse.json({ error: 'location not found' }, { status: 400 })
  }

  const resolvedColor = RC_COLORS.includes(color) ? color : 'blue'
  const resolvedType  = RC_LEAF_TYPES.includes(type) ? type : 'FOOD'

  // targetCostPct is canonical; targetFoodCostPct is a deprecated alias. If the
  // caller sends only the alias, mirror its value into both columns.
  let resolvedTargetCostPct: number | null = null
  let resolvedTargetFoodCostPct: number | null =
    targetFoodCostPct != null ? parseFloat(targetFoodCostPct) : null
  if (targetCostPct != null) {
    resolvedTargetCostPct = parseFloat(targetCostPct)
  } else if (targetFoodCostPct != null) {
    resolvedTargetCostPct = parseFloat(targetFoodCostPct)
    resolvedTargetFoodCostPct = parseFloat(targetFoodCostPct)
  }

  let scheduleFields
  try { scheduleFields = buildScheduleFields(body) }
  catch { return NextResponse.json({ error: 'Invalid service schedule' }, { status: 400 }) }

  const rc = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.revenueCenter.updateMany({ data: { isDefault: false } })
    }
    return tx.revenueCenter.create({
      data: {
        name: name.trim(),
        color: resolvedColor,
        locationId,
        isDefault: !!isDefault,
        isActive:  isActive !== undefined ? !!isActive : true,
        type:      resolvedType,
        description:       description       || null,
        managerName:       managerName       || null,
        targetCostPct:     resolvedTargetCostPct,
        targetFoodCostPct: resolvedTargetFoodCostPct,
        notes:             notes             || null,
        schedulingMode:  scheduleFields.schedulingMode,
        prepLeadMinutes: scheduleFields.prepLeadMinutes,
        serviceSchedule: scheduleFields.serviceSchedule ?? undefined,
      },
    })
  })

  return NextResponse.json(rc, { status: 201 })
}
