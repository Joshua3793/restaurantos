import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { RC_COLORS } from '@/lib/rc-colors'
import { requireSession, AuthError } from '@/lib/auth'
import { ACTIVE_SERVICES_INCLUDE } from '@/lib/rc-service-select'

// prepLeadMinutes is the only scheduling field left on RevenueCenter that the
// app still writes — service type + hours now live on Service rows instead.
function normalizePrepLead(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const rc = await prisma.revenueCenter.findUnique({
    where: { id: params.id },
    include: {
      services: ACTIVE_SERVICES_INCLUDE,
    },
  })
  if (!rc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(rc)
}

const RC_LEAF_TYPES = ['FOOD', 'DRINK'] as const

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({}))
  const { name, color, isDefault, isActive, type, locationId, description, managerName, targetCostPct, targetFoodCostPct, notes } = body

  const existing = await prisma.revenueCenter.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const resolvedColor = color !== undefined
    ? (RC_COLORS.includes(color) ? color : existing.color)
    : undefined
  const resolvedType = type !== undefined
    ? (RC_LEAF_TYPES.includes(type) ? type : existing.type)
    : undefined

  // Validate locationId if provided.
  if (locationId !== undefined) {
    const loc = await prisma.location.findUnique({ where: { id: locationId } })
    if (!loc) return NextResponse.json({ error: 'location not found' }, { status: 400 })
  }

  // targetCostPct is canonical; targetFoodCostPct is a deprecated alias. If the
  // caller sends only the alias, mirror its value into both columns.
  const targetCostUpdate: Record<string, unknown> = {}
  if (targetCostPct !== undefined) {
    targetCostUpdate.targetCostPct = targetCostPct != null ? parseFloat(targetCostPct) : null
    if (targetFoodCostPct !== undefined) {
      targetCostUpdate.targetFoodCostPct = targetFoodCostPct != null ? parseFloat(targetFoodCostPct) : null
    }
  } else if (targetFoodCostPct !== undefined) {
    const v = targetFoodCostPct != null ? parseFloat(targetFoodCostPct) : null
    targetCostUpdate.targetCostPct = v
    targetCostUpdate.targetFoodCostPct = v
  }

  const sendsPrepLead = 'prepLeadMinutes' in body
  const prepLeadMinutes = sendsPrepLead ? normalizePrepLead(body.prepLeadMinutes) : null

  const rc = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.revenueCenter.updateMany({ data: { isDefault: false } })
    }
    return tx.revenueCenter.update({
      where: { id: params.id },
      data: {
        ...(name?.trim()             ? { name: name.trim() }                                   : {}),
        ...(resolvedColor !== undefined ? { color: resolvedColor }                             : {}),
        ...(isDefault !== undefined  ? { isDefault: !!isDefault }                              : {}),
        ...(isActive  !== undefined  ? { isActive:  !!isActive  }                              : {}),
        ...(resolvedType !== undefined ? { type: resolvedType }                                : {}),
        ...(locationId !== undefined ? { locationId }                                          : {}),
        ...(description  !== undefined ? { description:       description       || null }      : {}),
        ...(managerName  !== undefined ? { managerName:       managerName       || null }      : {}),
        ...targetCostUpdate,
        ...(notes !== undefined      ? { notes: notes || null }                                : {}),
        ...(sendsPrepLead ? { prepLeadMinutes } : {}),
      },
    })
  })

  return NextResponse.json(rc)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const rc = await prisma.revenueCenter.findUnique({ where: { id: params.id } })
  if (!rc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (rc.isDefault) {
    return NextResponse.json({ error: 'Cannot delete the default revenue center' }, { status: 400 })
  }

  // Block delete if RC has linked data
  const [invoiceCount, salesCount, wastageCount, countCount] = await Promise.all([
    prisma.invoiceSession.count({ where: { revenueCenterId: params.id } }),
    prisma.salesEntry.count({ where: { revenueCenterId: params.id } }),
    prisma.wastageLog.count({ where: { revenueCenterId: params.id } }),
    prisma.countSession.count({ where: { revenueCenterId: params.id } }),
  ])

  if (invoiceCount + salesCount + wastageCount + countCount > 0) {
    return NextResponse.json({
      error: 'Cannot delete: this revenue center has linked invoices, sales, wastage, or count sessions.',
    }, { status: 400 })
  }

  await prisma.revenueCenter.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
