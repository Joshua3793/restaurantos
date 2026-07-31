import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * Tip-payroll fields on a Cook. Deliberately NOT able to touch name, initials,
 * homeStation or isActive — those stay on the ADMIN-gated /api/prep/cooks/[id]
 * route, so a manager editing the payout cannot rewrite the prep run sheet.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('MANAGER')
    const existing = await prisma.cook.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}

    if (body.lastName !== undefined) data.lastName = String(body.lastName ?? '').trim() || null
    if (body.posPosition !== undefined) data.posPosition = String(body.posPosition ?? '').trim() || null
    if (body.onTipPool !== undefined) {
      if (typeof body.onTipPool !== 'boolean') return NextResponse.json({ error: 'onTipPool must be a boolean' }, { status: 400 })
      data.onTipPool = body.onTipPool
    }
    if (body.wage !== undefined) {
      if (body.wage === null || body.wage === '') data.wage = null
      else {
        const v = Number(body.wage)
        if (!isFinite(v) || v < 0) return NextResponse.json({ error: 'wage must be a positive number' }, { status: 400 })
        data.wage = v
      }
    }
    if (body.dailyHourCap !== undefined) {
      if (body.dailyHourCap === null || body.dailyHourCap === '') data.dailyHourCap = null
      else {
        const v = Number(body.dailyHourCap)
        if (!isFinite(v) || v <= 0 || v > 24)
          return NextResponse.json({ error: 'dailyHourCap must be between 0 and 24 hours' }, { status: 400 })
        data.dailyHourCap = Math.round(v * 100) / 100
      }
    }
    if (body.tipRoleId !== undefined) {
      if (body.tipRoleId === null) data.tipRoleId = null
      else {
        const role = await prisma.tipRole.findFirst({ where: { id: String(body.tipRoleId), isActive: true } })
        if (!role) return NextResponse.json({ error: 'tipRoleId is not a live role' }, { status: 400 })
        data.tipRoleId = role.id
      }
    }
    if (body.clockId !== undefined) {
      const code = String(body.clockId ?? '').trim()
      if (!code) data.clockId = null
      else {
        const clash = await prisma.cook.findUnique({ where: { clockId: code } })
        if (clash && clash.id !== params.id)
          return NextResponse.json({ error: `Clock #${code} already belongs to ${clash.name}` }, { status: 409 })
        data.clockId = code
      }
    }

    const cook = await prisma.cook.update({ where: { id: params.id }, data })
    return NextResponse.json({
      id: cook.id, name: cook.name, lastName: cook.lastName, clockId: cook.clockId,
      wage: cook.wage == null ? null : Number(cook.wage),
      dailyHourCap: cook.dailyHourCap == null ? null : Number(cook.dailyHourCap),
      tipRoleId: cook.tipRoleId, onTipPool: cook.onTipPool,
    })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roster/[id] PATCH]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
