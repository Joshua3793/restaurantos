import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { applyLine, type LineAction } from '@/lib/checklists/apply-line'
import { pacificHHMM, runProgress } from '@/lib/checklists/rules'
import { loadRunView } from '@/lib/checklists/runs'
import { whoOf } from '@/lib/checklists/who'

export const dynamic = 'force-dynamic'

const SIGNED_MSG = 'Signed off — ask a lead to reopen'

/** Thrown inside the transaction when the run was signed off after we looked: rolls everything back. */
class RunLockedError extends Error {}

/**
 * PUT { action: 'tick' | 'untick' | 'value' | 'flag', ... } — answer one job.
 * A temperature answer also lands in the Temps log, in the same save. The line
 * remembers its Temps row, so a corrected reading replaces it, and an untick
 * or a flag removes it. Signed-off runs are locked (409) until a lead reopens.
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
    if (line.run.status === 'SIGNED') return NextResponse.json({ error: SIGNED_MSG }, { status: 409 })

    const body = (await req.json().catch(() => null)) as LineAction | null
    const who = await whoOf(user)
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
    const logsTemp = line.answer === 'TEMP' && !!line.tempUnitId
    const oldReadingId = line.tempReadingId
    const newReading = logsTemp && data.value != null
    // Existing reading is replaced in place; a first answer gets a fresh id we can store on the line.
    const readingId = newReading ? oldReadingId ?? randomUUID() : null

    try {
      await prisma.$transaction(async tx => {
        // Guarded on the run still being OPEN, so a sign-off that lands meanwhile wins.
        const upd = await tx.checklistRunLine.updateMany({
          where: { id: line.id, run: { status: 'OPEN' } },
          data: { ...data, ...(logsTemp || oldReadingId ? { tempReadingId: readingId } : {}) },
        })
        if (upd.count === 0) throw new RunLockedError()

        if (readingId) {
          const fields = {
            unitId: line.tempUnitId!,
            logDate: line.run.businessDate,
            time: pacificHHMM(now),
            temp: data.value!,
            recordedBy: who.name,
          }
          await tx.tempReading.upsert({
            where: { id: readingId },
            create: { id: readingId, ...fields },
            update: fields,
          })
        } else if (oldReadingId) {
          // deleteMany: a reading someone already removed from the Temps log is not an error.
          await tx.tempReading.deleteMany({ where: { id: oldReadingId } })
        }
      })
    } catch (e) {
      if (e instanceof RunLockedError) return NextResponse.json({ error: SIGNED_MSG }, { status: 409 })
      throw e
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
