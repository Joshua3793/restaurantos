import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const taskSelect = {
  id: true,
  name: true,
  revenueCenterId: true,
  linkedInventoryItemId: true,
  sortOrder: true,
  isActive: true,
  linkedInventoryItem: { select: { id: true, itemName: true } },
} as const

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession()
    const body = await req.json()
    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      data.name = name
    }
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive
    if ('linkedInventoryItemId' in body) {
      data.linkedInventoryItemId = body.linkedInventoryItemId ? String(body.linkedInventoryItemId) : null
    }
    const task = await prisma.prepTask.update({
      where: { id: params.id },
      data,
      select: taskSelect,
    })
    return NextResponse.json(task)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/prep/tasks/[id]', e)
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession()
    // Soft-deactivate to preserve history (never cascade history).
    await prisma.prepTask.update({ where: { id: params.id }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('DELETE /api/prep/tasks/[id]', e)
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 })
  }
}
