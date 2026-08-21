import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { Prisma } from '@prisma/client'

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
    // The app login this roster row belongs to. Deliberately explicit: nothing
    // in this route ever infers a link from a name or an email.
    if (body.userId !== undefined) {
      if (body.userId === null || body.userId === '') data.userId = null
      else {
        const id = String(body.userId)
        const account = await prisma.user.findUnique({ where: { id }, select: { id: true, isActive: true } })
        if (!account || !account.isActive)
          return NextResponse.json({ error: 'userId is not an active user' }, { status: 400 })
        const clash = await prisma.cook.findUnique({ where: { userId: id }, select: { id: true, name: true } })
        if (clash && clash.id !== params.id)
          return NextResponse.json({ error: `That login is already linked to ${clash.name}` }, { status: 409 })
        data.userId = id
      }
    }

    let cook
    try {
      cook = await prisma.cook.update({ where: { id: params.id }, data })
    } catch (e) {
      // Losing side of a concurrent update to the same clockId/userId: the
      // pre-check above raced another request past it. Map the unique
      // violation to the same readable 409 rather than letting it fall
      // through as a 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        if (typeof data.clockId === 'string') {
          const holder = await prisma.cook.findUnique({ where: { clockId: data.clockId as string } })
          return NextResponse.json(
            { error: `Clock #${data.clockId} already belongs to ${holder?.name ?? 'another cook'}` },
            { status: 409 },
          )
        }
        if (typeof data.userId === 'string') {
          const holder = await prisma.cook.findUnique({ where: { userId: data.userId as string }, select: { name: true } })
          return NextResponse.json(
            { error: `That login is already linked to ${holder?.name ?? 'another cook'}` },
            { status: 409 },
          )
        }
      }
      throw e
    }
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
