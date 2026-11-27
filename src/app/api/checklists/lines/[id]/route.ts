import { createHash, randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { applyLine, type LineAction } from '@/lib/checklists/apply-line'
import { pacificHHMM, runProgress } from '@/lib/checklists/rules'
import { loadRunView } from '@/lib/checklists/runs'
import { whoOf } from '@/lib/checklists/who'
import { ensureInboxSeeded } from '@/lib/inbox/tags'
import { syncFlagItem } from '@/lib/inbox/flags'

export const dynamic = 'force-dynamic'

const SIGNED_MSG = 'Signed off — ask a lead to reopen'

/** Thrown inside the transaction when the run was signed off after we looked: rolls everything back. */
class RunLockedError extends Error {}

/**
 * When the cook answered. A phone that saved with no signal replays its queue
 * later and sends `takenAt`; it is believed within the last 24 h and not in the
 * future (a few minutes of clock drift allowed), otherwise the answer is now.
 */
function answeredAt(raw: unknown, now: Date): Date {
  if (typeof raw !== 'string') return now
  const t = new Date(raw).getTime()
  if (Number.isNaN(t) || t > now.getTime() + 5 * 60_000 || t < now.getTime() - 24 * 60 * 60_000) return now
  return new Date(Math.min(t, now.getTime()))
}

/**
 * The Temps-log row id for a replayed first temp answer: the same job + the same
 * moment always give the same id, so two tabs replaying one queued answer at once
 * land on ONE reading (upsert) instead of two. UUID-shaped, like randomUUID().
 */
function replayReadingId(lineId: string, takenAt: string): string {
  const h = createHash('sha256').update(`checklist-reading:${lineId}:${takenAt}`).digest('hex')
  const variant = ((parseInt(h[16], 16) & 3) | 8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * PUT { action: 'tick' | 'untick' | 'value' | 'flag', ..., takenAt? } — answer one job.
 * Safe to replay: it SETS the job's state (last write wins) and a temp answer
 * upserts the one Temps row the line already points at.
 * A replay (`takenAt`) never overwrites a job someone else answered, unticked or
 * marked fixed AFTER it was taken: the job comes back unchanged with
 * `stale: true`, and the phone drops its queued answer.
 * A temperature answer also lands in the Temps log, in the same save. The line
 * remembers its Temps row, so a corrected reading replaces it, and an untick
 * or a flag removes it. Signed-off runs are locked (409) until a lead reopens.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession()
    const line = await prisma.checklistRunLine.findUnique({
      where: { id: params.id },
      include: { run: { include: { station: { select: { name: true, revenueCenterId: true, isShared: true } } } } },
    })
    if (!line) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    await assertRcWritable(user, line.run.station.revenueCenterId)
    if (line.run.status === 'SIGNED') return NextResponse.json({ error: SIGNED_MSG }, { status: 409 })

    const body = (await req.json().catch(() => null)) as LineAction | null
    const who = await whoOf(user)
    const rawTakenAt = (body as { takenAt?: unknown } | null)?.takenAt
    const takenMs = typeof rawTakenAt === 'string' ? new Date(rawTakenAt).getTime() : NaN
    if (!Number.isNaN(takenMs) && line.updatedAt.getTime() > takenMs) {
      // Who touched the job last: a "marked fixed" after the answer, else whoever answered (null = unticked).
      const lastBy = line.resolvedAt && (!line.doneAt || line.resolvedAt >= line.doneAt) ? line.resolvedById : line.doneById
      if (lastBy !== who.id) {
        const run = await loadRunView(line.runId)
        return NextResponse.json({ line: run.lines.find(l => l.id === line.id), progress: runProgress(run.lines), stale: true })
      }
    }
    const now = answeredAt(rawTakenAt, new Date())
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
    // One job on several lists: the other open copies today take the same answer.
    const siblings = line.linkId
      ? await prisma.checklistRunLine.findMany({
          where: {
            linkId: line.linkId, NOT: { id: line.id },
            run: { businessDate: line.run.businessDate, phase: line.run.phase, status: 'OPEN' },
          },
          select: { id: true, title: true, isBlocker: true, unit: true, tempReadingId: true },
        })
      : []
    const logsTemp = line.answer === 'TEMP' && !!line.tempUnitId
    // A shared job keeps ONE Temps-log reading, whichever copy wrote it.
    const oldReadingId = line.tempReadingId ?? siblings.find(s => s.tempReadingId)?.tempReadingId ?? null
    const siblingHeldReading = siblings.some(s => s.tempReadingId)
    const newReading = logsTemp && data.value != null
    // Existing reading is replaced in place; a first answer gets a fresh id we can store on the line
    // (a replayed one gets the id its job + moment always give, so a double replay can't make two rows).
    const readingId = newReading
      ? oldReadingId ?? (typeof rawTakenAt === 'string' && !Number.isNaN(takenMs) ? replayReadingId(line.id, rawTakenAt) : randomUUID())
      : null

    // Tags + flag routes must exist before the transaction opens (it seeds them on first use).
    await ensureInboxSeeded()

    try {
      await prisma.$transaction(async tx => {
        // Guarded on the run still being OPEN, so a sign-off that lands meanwhile wins.
        const upd = await tx.checklistRunLine.updateMany({
          where: { id: line.id, run: { status: 'OPEN' } },
          data: { ...data, ...(logsTemp || oldReadingId ? { tempReadingId: readingId } : {}) },
        })
        if (upd.count === 0) throw new RunLockedError()

        if (siblings.length) {
          await tx.checklistRunLine.updateMany({
            where: { id: { in: siblings.map(s => s.id) }, run: { status: 'OPEN' } },
            data: { ...data, ...(siblingHeldReading ? { tempReadingId: null } : {}) },
          })
        }

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

        // A flag lands in the Inbox; any other answer closes an open flag item. Same save, so they never disagree.
        await syncFlagItem(tx, {
          line: {
            id: line.id, title: line.title, isBlocker: line.isBlocker, unit: line.unit,
            status: data.status, flagReason: data.flagReason, flagNote: data.flagNote, value: data.value,
          },
          run: { id: line.runId },
          station: { name: line.run.station.name, revenueCenterId: line.run.station.revenueCenterId },
          who,
        })
        // The copy just answered owns the alert; any older alert on another copy closes.
        for (const s of siblings) {
          await syncFlagItem(tx, {
            line: { id: s.id, title: s.title, isBlocker: s.isBlocker, unit: s.unit, status: 'TODO', flagReason: null, flagNote: null, value: null },
            run: { id: line.runId },
            station: { name: line.run.station.name, revenueCenterId: line.run.station.revenueCenterId },
            who,
          })
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
