import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { applyLine, type LineAction } from '@/lib/checklists/apply-line'
import { pacificHHMM, runProgress } from '@/lib/checklists/rules'
import { loadRunView } from '@/lib/checklists/runs'
import { whoOf } from '@/lib/checklists/cook-view'

export const dynamic = 'force-dynamic'

/**
 * PUT { action: 'tick' | 'untick' | 'value' | 'flag', ... } — answer one job.
 * A temperature answer also lands in the Temps log, in the same save.
 * Signed-off runs are locked (409) until a lead reopens them.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession()
    const line = await prisma.checklistRunLine.findUnique({
      where: { id: params.id },
      include: { run: { include: { station: { select: { revenueCenterId: true, isShared: true } } } } },
    })
    if (!line) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    await assertRcWritable(user, line.run.station.revenueCenterId)
    if (line.run.status === 'SIGNED') {
      return NextResponse.json({ error: 'Signed off — ask a lead to reopen' }, { status: 409 })
    }

    const body = (await req.json().catch(() => null)) as LineAction | null
    const who = whoOf(user)
    const now = new Date()
    const result = applyLine(
      {
        answer: line.answer,
        safeMin: line.safeMin == null ? null : Number(line.safeMin),
        safeMax: line.safeMax == null ? null : Number(line.safeMax),
      },
      body as LineAction,
      who,
      now,
    )
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })

    const { data } = result
    const update = prisma.checklistRunLine.update({ where: { id: line.id }, data })
    if (line.answer === 'TEMP' && line.tempUnitId && data.value != null) {
      await prisma.$transaction([
        update,
        prisma.tempReading.create({
          data: {
            unitId: line.tempUnitId,
            logDate: line.run.businessDate,
            time: pacificHHMM(now),
            temp: data.value,
            recordedBy: who.name,
          },
        }),
      ])
    } else {
      await prisma.$transaction([update])
    }

    const run = await loadRunView(line.runId)
    const fresh = run.lines.find(l => l.id === line.id)
    return NextResponse.json({ line: fresh, progress: runProgress(run.lines) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PUT /api/checklists/lines/[id]', e)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
