import 'server-only'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { Phase } from './rules'
import { snapshotLines } from './snapshot'

type RunKey = { stationId: string; phase: Phase; businessDate: string }
const keyWhere = (k: RunKey) => ({ stationId_phase_businessDate: k })

/**
 * Opens the run for a station/phase/day. The first open copies that day's
 * applicable items into run lines; after that the run is left alone, so later
 * list edits never change a run that has started.
 *
 * Two simultaneous first opens are safe: the run upsert lands on one unique
 * key (a lost create race, P2002, is re-read) and the lines are inserted with
 * skipDuplicates against @@unique([runId, itemId]).
 */
export async function ensureRun(
  stationId: string,
  phase: Phase,
  businessDate: string,
): Promise<{ id: string; created: boolean }> {
  const key: RunKey = { stationId, phase, businessDate }

  const existing = await prisma.checklistRun.findUnique({ where: keyWhere(key), select: { id: true } })
  if (existing) return { id: existing.id, created: false }

  let runId: string
  try {
    const run = await prisma.checklistRun.upsert({
      where: keyWhere(key),
      create: key,
      update: {},
      select: { id: true },
    })
    runId = run.id
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e
    const won = await prisma.checklistRun.findUnique({ where: keyWhere(key), select: { id: true } })
    if (!won) throw e
    runId = won.id
  }

  const categories = await prisma.checklistCategory.findMany({
    where: { stationId, phase },
    orderBy: { sortOrder: 'asc' },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  })
  await prisma.checklistRunLine.createMany({
    data: snapshotLines(runId, categories, businessDate),
    skipDuplicates: true,
  })
  return { id: runId, created: true }
}

/** A run line as the screens read it. Decimals are numbers; dates are ISO strings. */
export type LineView = {
  id: string
  runId: string
  itemId: string | null
  categoryName: string
  title: string
  howTo: string | null
  isBlocker: boolean
  answer: 'TICK' | 'NUMBER' | 'TEMP'
  unit: string | null
  safeMin: number | null
  safeMax: number | null
  tempUnitId: string | null
  sortOrder: number
  status: 'TODO' | 'DONE' | 'FLAGGED'
  value: number | null
  doneById: string | null
  doneByName: string | null
  /** ISO string, or null */
  doneAt: string | null
  flagReason: 'BROKEN' | 'RAN_OUT' | 'OUT_OF_RANGE' | 'OTHER' | null
  flagNote: string | null
  resolvedById: string | null
  resolvedByName: string | null
  /** ISO string, or null */
  resolvedAt: string | null
}

/** One run with its lines (by sortOrder) and crew (by joinedAt). Dates are ISO strings so the JSON is stable. */
export type RunView = {
  id: string
  stationId: string
  phase: Phase
  businessDate: string
  status: 'OPEN' | 'SIGNED'
  signedOffByName: string | null
  /** ISO string, or null */
  signedOffAt: string | null
  handoverNote: string | null
  lines: LineView[]
  crew: { userId: string; userName: string }[]
}

const num = (v: unknown): number | null => (v == null ? null : Number(v))
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)

export async function loadRunView(runId: string): Promise<RunView> {
  const run = await prisma.checklistRun.findUnique({
    where: { id: runId },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
      crew: { orderBy: { joinedAt: 'asc' } },
    },
  })
  if (!run) throw new Error(`Checklist run ${runId} not found`)

  return {
    id: run.id,
    stationId: run.stationId,
    phase: run.phase,
    businessDate: run.businessDate,
    status: run.status,
    signedOffByName: run.signedOffByName,
    signedOffAt: iso(run.signedOffAt),
    handoverNote: run.handoverNote,
    lines: run.lines.map(l => ({
      id: l.id,
      runId: l.runId,
      itemId: l.itemId,
      categoryName: l.categoryName,
      title: l.title,
      howTo: l.howTo,
      isBlocker: l.isBlocker,
      answer: l.answer,
      unit: l.unit,
      safeMin: num(l.safeMin),
      safeMax: num(l.safeMax),
      tempUnitId: l.tempUnitId,
      sortOrder: l.sortOrder,
      status: l.status,
      value: num(l.value),
      doneById: l.doneById,
      doneByName: l.doneByName,
      doneAt: iso(l.doneAt),
      flagReason: l.flagReason,
      flagNote: l.flagNote,
      resolvedById: l.resolvedById,
      resolvedByName: l.resolvedByName,
      resolvedAt: iso(l.resolvedAt),
    })),
    crew: run.crew.map(c => ({ userId: c.userId, userName: c.userName })),
  }
}

/**
 * The most recent signed closing of this station before `beforeDate` that left
 * a note. A blank or whitespace-only note counts as none.
 */
export async function lastHandover(
  stationId: string,
  beforeDate: string,
): Promise<{ note: string; byName: string | null; businessDate: string } | null> {
  const run = await prisma.checklistRun.findFirst({
    where: {
      stationId,
      phase: 'CLOSE',
      status: 'SIGNED',
      businessDate: { lt: beforeDate },
      handoverNote: { not: null },
    },
    orderBy: { businessDate: 'desc' },
    select: { handoverNote: true, signedOffByName: true, businessDate: true },
  })
  const note = run?.handoverNote?.trim()
  if (!run || !note) return null
  return { note, byName: run.signedOffByName, businessDate: run.businessDate }
}
