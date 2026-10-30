// Pure helpers and shared shapes for the checklist editor (/checklist/edit and
// its API). No Prisma, no React.

import { daysLabel, EVERY_DAY, type Phase } from './rules'
import type { Answer } from './item-input'

export type EditItem = {
  id: string
  title: string
  howTo: string | null
  isBlocker: boolean
  answer: Answer
  unit: string | null
  safeMin: number | null
  safeMax: number | null
  tempUnitId: string | null
  days: number
}

export type CategoryTree = { id: string; name: string; items: EditItem[] }

export type EditStation = {
  id: string
  name: string
  color: string
  isShared: boolean
  isActive: boolean
  phases: { OPEN: CategoryTree[]; CLOSE: CategoryTree[] }
}

export type EditTempUnit = { id: string; name: string; safeMin: number | null; safeMax: number | null }

export type EditView = { stations: EditStation[]; tempUnits: EditTempUnit[] }

export type PillTone = 'red' | 'blue' | 'gold' | 'grey'
export type ItemPill = { label: string; tone: PillTone }

/** "0–4", "≥ 60", "≤ 4" or '' with no range. */
export function rangeLabel(min: number | null, max: number | null): string {
  if (min != null && max != null) return `${min}–${max}`
  if (min != null) return `≥ ${min}`
  if (max != null) return `≤ ${max}`
  return ''
}

/** "NUMBER °C 0–4", "NUMBER °C ≥ 60", "NUMBER PPM". */
export function numberPill(unit: string | null, min: number | null, max: number | null): string {
  return ['NUMBER', unit?.trim() || '', rangeLabel(min, max)].filter(Boolean).join(' ')
}

/** The tags under an item in the editor, in board order. */
export function itemPills(item: EditItem, phase: Phase, tempUnitName: string | null): ItemPill[] {
  const pills: ItemPill[] = []
  if (item.isBlocker) pills.push({ label: phase === 'OPEN' ? 'BEFORE DOORS' : 'BEFORE YOU LEAVE', tone: 'red' })
  if (item.answer === 'NUMBER') pills.push({ label: numberPill(item.unit, item.safeMin, item.safeMax), tone: 'blue' })
  else if (item.answer === 'TEMP') pills.push({ label: `TEMP · ${tempUnitName ?? 'unit removed'}`, tone: 'blue' })
  const d = daysLabel(item.days)
  if (d) pills.push({ label: d, tone: 'gold' })
  if (item.answer === 'TICK') pills.push({ label: 'TICK', tone: 'grey' })
  return pills
}

/** Day toggles in M T W T F S S order; toggle i is bit 1 << i (MON = 1 … SUN = 64). */
export const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const

export function daysToToggles(days: number): boolean[] {
  return DAY_LETTERS.map((_, i) => (days & (1 << i)) !== 0)
}

export function togglesToDays(toggles: boolean[]): number {
  return toggles.slice(0, 7).reduce((acc, on, i) => (on ? acc | (1 << i) : acc), 0)
}

export const ALL_DAYS = EVERY_DAY

/** The ids with the one at `index` swapped one place up (-1) or down (+1); unchanged at the ends. */
export function moveId(ids: string[], index: number, dir: -1 | 1): string[] {
  const j = index + dir
  if (index < 0 || index >= ids.length || j < 0 || j >= ids.length) return ids
  const next = [...ids]
  ;[next[index], next[j]] = [next[j], next[index]]
  return next
}

/** A copied category's name: " (copy)" appended when the target already has it (any case). */
export function copyName(name: string, taken: Iterable<string>): string {
  const set = new Set(Array.from(taken, n => n.trim().toLowerCase()))
  return set.has(name.trim().toLowerCase()) ? `${name} (copy)` : name
}

/** How many active jobs a station has in a phase. */
export function phaseCount(s: Pick<EditStation, 'phases'>, phase: Phase): number {
  return s.phases[phase].reduce((n, c) => n + c.items.length, 0)
}

/** Shared station first ("Everyone"), then the rest in the order the API gave (sortOrder). */
export function chipOrder<T extends { isShared: boolean }>(stations: T[]): T[] {
  return [...stations.filter(s => s.isShared), ...stations.filter(s => !s.isShared)]
}

export const chipName = (s: { isShared: boolean; name: string }) => (s.isShared ? 'Everyone' : s.name)
