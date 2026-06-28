import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { RC_COLORS } from '@/lib/rc-colors'
import { buildScheduleFields } from '@/lib/rc-schedule'

const RC_TYPES = ['restaurant', 'catering', 'events', 'retail', 'other'] as const

export async function GET() {
  let rcs = await prisma.revenueCenter.findMany({ orderBy: { createdAt: 'asc' } })

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
    rcs = [defaultRc]
  }

  return NextResponse.json(rcs)
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { name, color, isDefault, isActive, type, description, managerName, targetFoodCostPct, notes } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const resolvedColor = RC_COLORS.includes(color) ? color : 'blue'
  const resolvedType  = RC_TYPES.includes(type)  ? type  : 'other'

  let scheduleFields
  try { scheduleFields = buildScheduleFields(body) }
  catch { return NextResponse.json({ error: 'Invalid service schedule' }, { status: 400 }) }

  const rc = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.revenueCenter.updateMany({ data: { isDefault: false } })
    }
    // A RevenueCenter requires a Location. Until the two-tier picker lands
    // (Task 7+), attach new RCs to the default Location (or any Location if no
    // default is flagged); create one if none exist yet.
    let loc =
      (await tx.location.findFirst({ where: { isDefault: true } })) ??
      (await tx.location.findFirst())
    if (!loc) {
      loc = await tx.location.create({
        data: { name: name.trim(), color: resolvedColor, isDefault: true },
      })
    }
    return tx.revenueCenter.create({
      data: {
        name: name.trim(),
        color: resolvedColor,
        locationId: loc.id,
        isDefault: !!isDefault,
        isActive:  isActive !== undefined ? !!isActive : true,
        type:      resolvedType,
        description:       description       || null,
        managerName:       managerName       || null,
        targetFoodCostPct: targetFoodCostPct != null ? parseFloat(targetFoodCostPct) : null,
        notes:             notes             || null,
        schedulingMode:  scheduleFields.schedulingMode,
        prepLeadMinutes: scheduleFields.prepLeadMinutes,
        serviceSchedule: scheduleFields.serviceSchedule ?? undefined,
      },
    })
  })

  return NextResponse.json(rc, { status: 201 })
}
