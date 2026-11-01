// Server-only: seeds the Inbox tags + flag routes the first time anything asks,
// and reads the tag list. Pure rules live in ./rules.
import type { InboxBuiltIn, ChecklistFlagReason } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { SEED_TAGS, SEED_ROUTES, type TagLite } from '@/lib/inbox/rules'

/** The 8 colours a tag may use (Money's seed purple is only ever an existing value). */
export const TAG_PALETTE = [
  '#71717a', '#dc2626', '#ca8a04', '#ea580c', '#16a34a', '#db2777', '#0d9488', '#2563eb',
] as const

export const ROUTE_REASONS = ['BROKEN', 'RAN_OUT', 'OTHER'] as const
export type RouteReason = (typeof ROUTE_REASONS)[number]

export function isPaletteColor(color: unknown): color is string {
  return typeof color === 'string' && (TAG_PALETTE as readonly string[]).includes(color.toLowerCase())
}

/**
 * Seed the built-in + starter tags and the default flag routes. Only when there
 * are no tags at all (inactive ones count, so a removed starter tag stays gone).
 * Deterministic ids + skipDuplicates make a race between two first requests harmless.
 */
export async function ensureInboxSeeded(): Promise<void> {
  if ((await prisma.inboxTag.count()) > 0) return
  await prisma.inboxTag.createMany({
    data: SEED_TAGS.map(t => ({ ...t, builtIn: t.builtIn as InboxBuiltIn | null })),
    skipDuplicates: true,
  })
  await prisma.inboxFlagRoute.createMany({
    data: Object.entries(SEED_ROUTES).map(([reason, tagId]) => ({
      reason: reason as ChecklistFlagReason,
      tagId,
    })),
    skipDuplicates: true,
  })
}

/** Every tag, active and inactive, in display order. */
export async function loadTags(): Promise<TagLite[]> {
  const rows = await prisma.inboxTag.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, builtIn: true, name: true, color: true,
      cookCanPick: true, managerOnly: true, isActive: true,
    },
  })
  return rows.map(r => ({ ...r, builtIn: r.builtIn as string | null }))
}
