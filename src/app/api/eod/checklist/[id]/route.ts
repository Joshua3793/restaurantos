import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const itemSelect = {
  id: true, revenueCenterId: true, section: true, title: true,
  meta: true, sortOrder: true, isBlocker: true,
} as const

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('ADMIN')
    const body = await req.json()
    const data: Record<string, unknown> = {}
    if (body.section !== undefined) data.section = String(body.section).trim()
    if (body.title !== undefined) data.title = String(body.title).trim()
    if (body.meta !== undefined) data.meta = body.meta ? String(body.meta) : null
    if (body.isBlocker !== undefined) data.isBlocker = Boolean(body.isBlocker)
    const item = await prisma.eodCheckItem.update({ where: { id: params.id }, data, select: itemSelect })
    return NextResponse.json(item)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/eod/checklist/[id]', e)
    return NextResponse.json({ error: 'Failed to update item' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('ADMIN')
    await prisma.eodCheckItem.update({ where: { id: params.id }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('DELETE /api/eod/checklist/[id]', e)
    return NextResponse.json({ error: 'Failed to delete item' }, { status: 500 })
  }
}
