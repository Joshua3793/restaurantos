import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { loadSettings } from '@/lib/tips/settings'
import { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'

/** Initials from a first name — matches the ADMIN cook form's normalisation. */
function initialsFor(first: string, last: string): string {
  const a = first.trim()[0] ?? 'X'
  const b = last.trim()[0] ?? ''
  return (a + b).toUpperCase().slice(0, 3)
}

/**
 * Creates a roster row from a clock punch stranded on the Checks tab.
 * MANAGER (not ADMIN, like /api/prep/cooks) on purpose: the person running the
 * payout must be able to un-strand hours. Creation only — this route never
 * deletes or deactivates a cook.
 */
export async function POST(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const body = await req.json().catch(() => ({}))
    const first = String(body.firstName ?? '').trim()
    const last = String(body.lastName ?? '').trim()
    const clockId = String(body.clockId ?? '').trim()
    if (!first) return NextResponse.json({ error: 'firstName is required' }, { status: 400 })
    if (!clockId) return NextResponse.json({ error: 'clockId is required' }, { status: 400 })

    const clash = await prisma.cook.findUnique({ where: { clockId } })
    if (clash) return NextResponse.json({ error: `Clock #${clockId} already belongs to ${clash.name}` }, { status: 409 })

    // Position → role, via the map in Tip settings; falls back to the last role.
    const settings = await loadSettings()
    const posMap = (settings.posMap ?? {}) as Record<string, string>
    const position = String(body.position ?? '').trim()
    const roles = await prisma.tipRole.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } })
    const mapped = posMap[position]
    const roleId = roles.find(r => r.id === mapped)?.id ?? roles[roles.length - 1]?.id ?? null

    let cook
    try {
      cook = await prisma.cook.create({
        data: {
          name: first,
          lastName: last || null,
          initials: initialsFor(first, last),
          clockId,
          posPosition: position || null,
          tipRoleId: roleId,
          // Prefilled once, then owned by the person — never re-read from settings.
          dailyHourCap: settings.defaultDailyHourCap,
          onTipPool: true,
          sortOrder: await prisma.cook.count(),
        },
      })
    } catch (e) {
      // Losing side of a concurrent create for the same clockId: the pre-check
      // above raced another request past it. Map the unique violation to the
      // same readable 409 rather than letting it fall through as a 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const holder = await prisma.cook.findUnique({ where: { clockId } })
        return NextResponse.json(
          { error: `Clock #${clockId} already belongs to ${holder?.name ?? 'another cook'}` },
          { status: 409 },
        )
      }
      throw e
    }
    return NextResponse.json({ id: cook.id }, { status: 201 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roster POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
