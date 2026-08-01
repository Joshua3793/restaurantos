import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { toRoleDto } from '@/lib/tips/roles'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await requireSession('MANAGER')
    const roles = await prisma.tipRole.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    return NextResponse.json(roles.map(toRoleDto))
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roles GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const body = await req.json().catch(() => ({}))
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    const multiplier = Number(body.multiplier ?? 1)
    if (!isFinite(multiplier) || multiplier < 0 || multiplier > 5)
      return NextResponse.json({ error: 'multiplier must be between 0 and 5' }, { status: 400 })
    const count = await prisma.tipRole.count({ where: { isActive: true } })
    const role = await prisma.tipRole.create({ data: { name, multiplier, sortOrder: count } })
    return NextResponse.json(toRoleDto(role), { status: 201 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roles POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
