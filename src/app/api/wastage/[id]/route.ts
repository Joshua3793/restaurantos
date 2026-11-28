import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'
import { displayName } from '@/lib/checklists/who'
import { canDeleteWaste } from '../rules'

export const dynamic = 'force-dynamic'

// DELETE /api/wastage/:id — the Undo after a save, and ⋯ Delete on an entry.
// Allowed for the person who logged it within 24 h, or MANAGER+ any time
// (src/app/api/wastage/rules.ts).
//
// Stock: a waste entry writes NO stock row. Theoretical on-hand is derived at read
// time from the WastageLog rows themselves (buildWastageMap in
// src/lib/count-expected.ts), and the COGS/variance reports read the same rows —
// so removing the row IS the reversal. The cached theoretical map is dropped
// (invalidatesTheoretical) so the item's stock goes back up on the next read.
async function handleDELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const log = await prisma.wastageLog.findUnique({
    where: { id: params.id },
    select: { id: true, date: true, loggedBy: true, revenueCenterId: true },
  })
  if (!log) return NextResponse.json({ error: 'That entry is already gone.' }, { status: 404 })

  try { await assertRcWritable(user, log.revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  if (!canDeleteWaste({ role: user.role, name: await displayName(user) }, log)) {
    return NextResponse.json(
      { error: 'Only the person who logged it can delete it, within a day. Ask a manager.' },
      { status: 403 },
    )
  }

  // deleteMany: a double-tap (Undo + ⋯ Delete) racing to the same row is a no-op,
  // not a P2025 500.
  await prisma.wastageLog.deleteMany({ where: { id: log.id } })
  return NextResponse.json({ ok: true, id: log.id })
}

export const DELETE = invalidatesTheoretical(handleDELETE)
