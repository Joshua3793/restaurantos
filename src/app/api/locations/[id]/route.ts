import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { RC_COLORS } from '@/lib/rc-colors'
import { ACTIVE_SERVICES_INCLUDE, normalizePrepLead } from '@/lib/rc-service-select'
import { User } from '@prisma/client'

export const dynamic = 'force-dynamic'

const LOCATION_TYPES = ['restaurant', 'catering', 'other'] as const

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const loc = await prisma.location.findUnique({
    where: { id: params.id },
    include: {
      revenueCenters: {
        include: {
          services: ACTIVE_SERVICES_INCLUDE,
        },
      },
    },
  })
  if (!loc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(loc)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let user: User
  try { user = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  void user

  const body = await req.json().catch(() => ({}))
  const { name, color, type, isDefault, isActive, description, managerName, notes, defaultRevenueCenterId } = body

  const existing = await prisma.location.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Validate the default RC belongs to this location (null clears it).
  if (defaultRevenueCenterId !== undefined && defaultRevenueCenterId !== null) {
    const rc = await prisma.revenueCenter.findUnique({ where: { id: defaultRevenueCenterId } })
    if (!rc || rc.locationId !== params.id) {
      return NextResponse.json({ error: 'default revenue center must belong to this location' }, { status: 400 })
    }
  }

  const resolvedColor = color !== undefined
    ? (RC_COLORS.includes(color) ? color : existing.color)
    : undefined
  const resolvedType = type !== undefined
    ? (LOCATION_TYPES.includes(type) ? type : existing.type)
    : undefined

  const sendsPrepLead = 'prepLeadMinutes' in body
  const prepLeadMinutes = sendsPrepLead ? normalizePrepLead(body.prepLeadMinutes) : null

  const loc = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.location.updateMany({ data: { isDefault: false } })
    }
    return tx.location.update({
      where: { id: params.id },
      data: {
        ...(name?.trim()                ? { name: name.trim() }                          : {}),
        ...(resolvedColor !== undefined ? { color: resolvedColor }                       : {}),
        ...(resolvedType !== undefined  ? { type: resolvedType }                         : {}),
        ...(isDefault !== undefined     ? { isDefault: !!isDefault }                     : {}),
        ...(isActive  !== undefined     ? { isActive:  !!isActive }                      : {}),
        ...(description !== undefined   ? { description: description || null }           : {}),
        ...(managerName !== undefined   ? { managerName: managerName || null }           : {}),
        ...(notes !== undefined         ? { notes: notes || null }                       : {}),
        ...(defaultRevenueCenterId !== undefined ? { defaultRevenueCenterId: defaultRevenueCenterId || null } : {}),
        ...(sendsPrepLead ? { prepLeadMinutes } : {}),
      },
    })
  })

  return NextResponse.json(loc)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const loc = await prisma.location.findUnique({ where: { id: params.id } })
  if (!loc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (loc.isDefault) {
    return NextResponse.json({ error: 'Cannot delete the default location' }, { status: 400 })
  }

  const rcCount = await prisma.revenueCenter.count({ where: { locationId: params.id } })
  if (rcCount > 0) {
    return NextResponse.json({
      error: 'Cannot delete: this location still has revenue centers.',
    }, { status: 400 })
  }

  await prisma.location.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
