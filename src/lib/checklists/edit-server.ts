import 'server-only'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { AuthError } from '@/lib/auth'
import type { EditItem } from './edit-format'

// Shared bits of the checklist editor routes (/api/checklists/{stations,categories,items,reorder,copy}).

export const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

export const notFound = () => fail(404, 'Not found')

/** Maps a thrown error to a response: AuthError keeps its status, anything else is a logged 500. */
export function caught(e: unknown, where: string, message = 'Could not save — try again.') {
  if (e instanceof AuthError) return fail(e.status, e.message)
  console.error(where, e)
  return fail(500, message)
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null)
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

const num = (v: unknown) => (v == null ? null : Number(v))

export const ITEM_SELECT = {
  id: true, title: true, howTo: true, isBlocker: true, answer: true, unit: true,
  safeMin: true, safeMax: true, tempUnitId: true, days: true,
} as const

type ItemRow = {
  id: string; title: string; howTo: string | null; isBlocker: boolean; answer: EditItem['answer']
  unit: string | null; safeMin: unknown; safeMax: unknown; tempUnitId: string | null; days: number
}

/** Prisma Decimals become numbers. */
export function toEditItem(r: ItemRow): EditItem {
  return {
    id: r.id, title: r.title, howTo: r.howTo, isBlocker: r.isBlocker, answer: r.answer,
    unit: r.unit, safeMin: num(r.safeMin), safeMax: num(r.safeMax), tempUnitId: r.tempUnitId, days: r.days,
  }
}

/** A TEMP item's unit must be an active Temps unit in this kitchen, or shared by every kitchen. */
export async function tempUnitAllowed(tempUnitId: string, rcId: string): Promise<boolean> {
  const u = await prisma.tempUnit.findFirst({
    where: { id: tempUnitId, isActive: true, OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] },
    select: { id: true },
  })
  return !!u
}
