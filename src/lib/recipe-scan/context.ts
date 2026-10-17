// Recipe Scan: load what the pure draft builder needs from the database —
// the candidates (active items + PREP recipes), learned wordings and counts,
// categories — and price a draft's lines at read time (never stored).
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { normaliseAliasText } from '@/lib/alias-text'
import { formatPurchaseDisplay } from '@/lib/count-uom'
import { PRICING_SELECT, asChainItem } from '@/lib/item-model'
import { lastCost, type ChainRow } from '@/lib/cost-basis'
import { similarity } from '@/lib/recipe-match'
import { convertQtyBridged, dimensionallyCostable } from '@/lib/uom'
import { resolveCandidates, type Candidate } from './match'
import { singular, type AmountItem } from './amount'
import { rematchDraft, type DraftContext } from './build-draft'
import { isDraftData } from './save-rules'
import type { DraftData } from './types'

/** A candidate as the picker shows it: plus the unit its amounts are saved in. */
export type ScanCandidate = Candidate & { baseUnit: string }

function amountItemOf(row: ChainRow): AmountItem {
  const c = asChainItem(row)
  return {
    dimension: c.dimension,
    baseUnit: c.baseUnit,
    eachMeasureQty: c.eachMeasure?.qty ?? null,
    eachMeasureUnit: c.eachMeasure?.unit ?? null,
    densityGPerMl: c.densityGPerMl ?? null,
  }
}

/**
 * Every ingredient a scanned line may link to: active stocked/non-stocked items
 * that are not a prep recipe's own output, plus active PREP recipes. Merged-away
 * items are loaded too (inactive) so a learned wording that points at one can be
 * followed to its target; `resolveCandidates` never offers them.
 */
export async function loadCandidates(): Promise<{ candidates: ScanCandidate[]; items: Map<string, AmountItem> }> {
  const [items, recipes] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: {
        recipe: null,
        NOT: { category: { equals: 'PREPD', mode: 'insensitive' } },
        OR: [{ isActive: true }, { mergedIntoId: { not: null } }],
      },
      select: {
        id: true, itemName: true, isActive: true, mergedIntoId: true, ...PRICING_SELECT,
        _count: { select: { recipeIngredients: true } },
        supplierPrices: { where: { isPrimary: true }, select: { supplier: { select: { name: true } } }, take: 1 },
      },
    }),
    prisma.recipe.findMany({
      where: { type: 'PREP', isActive: true },
      select: {
        id: true, name: true, yieldUnit: true,
        category: { select: { name: true } },
        inventoryItem: { select: { ...PRICING_SELECT } },
        _count: { select: { usedInRecipes: true } },
      },
    }),
  ])

  const candidates: ScanCandidate[] = []
  const amountItems = new Map<string, AmountItem>()
  for (const it of items) {
    candidates.push({
      kind: 'item', id: it.id, name: it.itemName, active: it.isActive, mergedIntoId: it.mergedIntoId,
      usedInRecipes: it._count.recipeIngredients,
      boughtAs: formatPurchaseDisplay(it),
      supplier: it.supplierPrices[0]?.supplier.name ?? null,
      baseUnit: it.baseUnit,
    })
    amountItems.set(it.id, amountItemOf(it))
  }
  for (const r of recipes) {
    candidates.push({
      kind: 'recipe', id: r.id, name: r.name, active: true, mergedIntoId: null,
      usedInRecipes: r._count.usedInRecipes,
      boughtAs: `PREP · ${r.category.name}`,
      supplier: null,
      baseUnit: r.inventoryItem?.baseUnit ?? r.yieldUnit,
    })
    if (r.inventoryItem) amountItems.set(r.id, amountItemOf(r.inventoryItem))
  }
  return { candidates, items: amountItems }
}

export async function loadDraftContext(opts: {
  revenueCenterId: string | null
  siblingTitles: string[]
}): Promise<DraftContext> {
  const [{ candidates, items }, aliasRows, measureRows, categories] = await Promise.all([
    loadCandidates(),
    prisma.recipeTextAlias.findMany({ select: { text: true, inventoryItemId: true, linkedRecipeId: true } }),
    prisma.itemCountMeasure.findMany({ select: { inventoryItemId: true, word: true, qty: true, unit: true } }),
    prisma.recipeCategory.findMany({
      where: {
        type: 'PREP',
        ...(opts.revenueCenterId
          ? { OR: [{ revenueCenterId: opts.revenueCenterId }, { revenueCenterId: null }] }
          : {}),
      },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  ])

  const aliases: DraftContext['aliases'] = new Map()
  for (const a of aliasRows) {
    if (a.inventoryItemId) aliases.set(a.text, { kind: 'item', id: a.inventoryItemId })
    else if (a.linkedRecipeId) aliases.set(a.text, { kind: 'recipe', id: a.linkedRecipeId })
  }
  const measures: DraftContext['measures'] = new Map()
  for (const m of measureRows) {
    const qty = Number(m.qty)
    if (!Number.isFinite(qty) || qty <= 0) continue
    measures.set(`${m.inventoryItemId}:${singular(m.word)}`, { word: m.word, qty, unit: m.unit })
  }

  return {
    candidates, aliases, measures, items, categories,
    revenueCenterId: opts.revenueCenterId,
    siblingTitles: opts.siblingTitles,
  }
}

/** Picker search: live candidates whose name contains the words, then the closest by word overlap. */
export function searchCandidates<T extends Candidate>(q: string, all: T[], limit = 20): T[] {
  const { list } = resolveCandidates(all)
  const live = list as T[]
  const nq = normaliseAliasText(q)
  if (!nq) {
    return [...live].sort((a, b) => b.usedInRecipes - a.usedInRecipes || a.name.localeCompare(b.name)).slice(0, limit)
  }
  const words = nq.split(' ')
  const scored = live.map(c => {
    const n = normaliseAliasText(c.name)
    const score = n === nq ? 3
      : n.includes(nq) ? 2
      : words.every(w => n.includes(w)) ? 1.5
      : similarity(nq, n)
    return { c, score }
  }).filter(s => s.score >= 0.3)
  scored.sort((a, b) =>
    b.score - a.score || b.c.usedInRecipes - a.c.usedInRecipes || a.c.name.localeCompare(b.c.name))
  return scored.slice(0, limit).map(s => s.c)
}

export type LineCosts = Record<string, { lineCost: number | null; unpriced: boolean }>

/**
 * One line's cost against a priced row (LAST basis, the same $/base the picker
 * shows); null when the amount is unknown or cannot be costed against the item.
 */
export function costOfLine(row: ChainRow, qty: number | null, unit: string | null): number | null {
  if (qty === null || !Number.isFinite(qty)) return null
  const chain = asChainItem(row)
  const u = unit || chain.baseUnit
  if (!dimensionallyCostable(u, chain.baseUnit, chain.eachMeasure)) return null
  const inBase = convertQtyBridged(qty, u, chain.baseUnit, chain.eachMeasure, chain.densityGPerMl)
  if (!Number.isFinite(inBase)) return null
  return inBase * lastCost(row)
}

/** Live cost of every line, read from the linked item's (or prep recipe's item's) current pricing. */
export async function draftCosts(d: DraftData): Promise<LineCosts> {
  const itemIds = new Set<string>()
  const recipeIds = new Set<string>()
  for (const l of d.lines) {
    if (l.link?.kind === 'item') itemIds.add(l.link.id)
    else if (l.link?.kind === 'recipe') recipeIds.add(l.link.id)
  }
  const [items, recipes] = await Promise.all([
    itemIds.size
      ? prisma.inventoryItem.findMany({ where: { id: { in: [...itemIds] } }, select: { id: true, ...PRICING_SELECT } })
      : Promise.resolve([]),
    recipeIds.size
      ? prisma.recipe.findMany({
          where: { id: { in: [...recipeIds] } },
          select: { id: true, inventoryItem: { select: { ...PRICING_SELECT } } },
        })
      : Promise.resolve([]),
  ])
  const rows = new Map<string, ChainRow>()
  for (const it of items) rows.set(`item:${it.id}`, it)
  for (const r of recipes) if (r.inventoryItem) rows.set(`recipe:${r.id}`, r.inventoryItem)

  const out: LineCosts = {}
  for (const l of d.lines) {
    const row = l.link ? rows.get(`${l.link.kind}:${l.link.id}`) : undefined
    if (!row) { out[l.key] = { lineCost: null, unpriced: false }; continue }
    out[l.key] = { lineCost: costOfLine(row, l.qty, l.unit), unpriced: lastCost(row) === 0 }
  }
  return out
}

/**
 * Re-match the scan's other OPEN drafts — after a save, a sibling recipe the
 * page referred to ("1 cup Aioli, see p. 42") now exists and can be linked.
 */
export async function rematchOpenDrafts(scanId: string, exceptId?: string): Promise<void> {
  const drafts = await prisma.recipeScanDraft.findMany({
    where: { scanId, status: 'OPEN', ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, data: true },
  })
  if (drafts.length === 0) return
  const scan = await prisma.recipeScan.findUnique({
    where: { id: scanId },
    select: { revenueCenterId: true, drafts: { select: { title: true } } },
  })
  const ctx = await loadDraftContext({
    revenueCenterId: scan?.revenueCenterId ?? null,
    siblingTitles: scan?.drafts.map(d => d.title) ?? [],
  })
  for (const dr of drafts) {
    if (!isDraftData(dr.data)) continue
    const next = rematchDraft(dr.data, ctx)
    if (JSON.stringify(next) === JSON.stringify(dr.data)) continue
    await prisma.recipeScanDraft.updateMany({
      where: { id: dr.id, status: 'OPEN' },
      data: { data: next as unknown as Prisma.InputJsonValue },
    })
  }
}
