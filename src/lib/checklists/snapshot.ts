// Pure: turns a station's list template into the run lines for one business day.
// No Prisma runtime import (types only), so it is safe to unit-test and reuse.
import type { Prisma } from '@prisma/client'
import { appliesOn } from './rules'

type Dec = Prisma.Decimal | string | number | null

/** The fields of a ChecklistItem row that a snapshot reads. */
export type ItemTemplate = {
  id: string
  title: string
  howTo: string | null
  isBlocker: boolean
  answer: 'TICK' | 'NUMBER' | 'TEMP'
  unit: string | null
  safeMin: Dec
  safeMax: Dec
  tempUnitId: string | null
  days: number
  sortOrder: number
  isActive: boolean
}

export type CategoryTemplate = {
  name: string
  sortOrder: number
  isActive: boolean
  items: ItemTemplate[]
}

/** One ChecklistRunLine create row. Decimals are copied as they came. */
export type LineCreate = {
  runId: string
  itemId: string
  categoryName: string
  title: string
  howTo: string | null
  isBlocker: boolean
  answer: 'TICK' | 'NUMBER' | 'TEMP'
  unit: string | null
  safeMin: Dec
  safeMax: Dec
  tempUnitId: string | null
  sortOrder: number
}

/**
 * Lines for one run: active categories, then active items that apply on the
 * date, ordered by category sortOrder then item sortOrder and renumbered 0..n-1.
 */
export function snapshotLines(
  runId: string,
  categories: CategoryTemplate[],
  businessDate: string,
): LineCreate[] {
  const out: LineCreate[] = []
  const cats = categories.filter(c => c.isActive).sort((a, b) => a.sortOrder - b.sortOrder)
  for (const cat of cats) {
    const items = cat.items
      .filter(i => i.isActive && appliesOn(i.days, businessDate))
      .sort((a, b) => a.sortOrder - b.sortOrder)
    for (const i of items) {
      out.push({
        runId,
        itemId: i.id,
        categoryName: cat.name,
        title: i.title,
        howTo: i.howTo,
        isBlocker: i.isBlocker,
        answer: i.answer,
        unit: i.unit,
        safeMin: i.safeMin,
        safeMax: i.safeMax,
        tempUnitId: i.tempUnitId,
        sortOrder: out.length,
      })
    }
  }
  return out
}
