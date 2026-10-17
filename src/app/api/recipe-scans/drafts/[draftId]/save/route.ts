import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { assertKnownUnit, UnitError } from '@/lib/uom'
import { validateMethod } from '@/lib/recipe-method'
import { resyncPrepRecipe } from '@/lib/recipeCosts'
import { syncPrepItemFromRecipe } from '@/lib/prep-sync'
import { linkPrepInventoryItem } from '@/lib/prep-recipe-item'
import {
  saveBlockers, isDraftData, ingredientRows, aliasLearnings, countMeasureLearnings,
} from '@/lib/recipe-scan/save-rules'
import { rematchOpenDrafts } from '@/lib/recipe-scan/context'
import type { DraftLine } from '@/lib/recipe-scan/types'

export const dynamic = 'force-dynamic'

class AlreadySaved extends Error {}

const ALREADY = 'This recipe was already saved from this scan.'

// POST /api/recipe-scans/drafts/[draftId]/save { data: DraftData }
// The body carries the draft exactly as the review screen shows it, so an
// autosave still in flight can't make the save use an older copy. One
// transaction: claim the draft (OPEN → SAVED, so a double tap makes ONE
// recipe), create the PREP recipe + its PREPD item + every line, and learn the
// chef's wordings and count weights. Then the usual PREP side effects and a
// re-match of the scan's other open drafts (a sibling may now exist).
export async function POST(req: NextRequest, { params }: { params: { draftId: string } }) {
  let user
  try { user = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => null)
  const d: unknown = body?.data
  if (!isDraftData(d)) return NextResponse.json({ error: 'Invalid draft' }, { status: 400 })

  const draft = await prisma.recipeScanDraft.findUnique({
    where: { id: params.draftId },
    select: { id: true, scanId: true, status: true },
  })
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  if (draft.status !== 'OPEN') return NextResponse.json({ error: ALREADY }, { status: 409 })
  const name = d.name.trim()

  const sameName = await prisma.recipe.findMany({
    where: { type: 'PREP', name: { equals: name, mode: 'insensitive' } },
    select: { name: true },
  })
  const blockers = saveBlockers(d, sameName.map(r => r.name))
  if (blockers.length) return NextResponse.json({ error: blockers[0], blockers }, { status: 400 })

  if (d.revenueCenterId) {
    try { await assertRcWritable(user, d.revenueCenterId) }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  let yieldUnit: string
  try { yieldUnit = assertKnownUnit(d.yieldUnit, 'yield unit') }
  catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }
  const baseYieldQty = d.yieldQty as number // saveBlockers: a positive number

  const v = validateMethod(d.method)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  const category = await prisma.recipeCategory.findFirst({
    where: { id: d.categoryId as string, type: 'PREP' },
    select: { id: true },
  })
  if (!category) return NextResponse.json({ error: 'Pick a category', blockers: ['Pick a category'] }, { status: 400 })

  // Every link must still be a live item / active PREP recipe (the draft GET
  // drops stale ones; this catches a change since the screen loaded).
  const itemIds = [...new Set(d.lines.flatMap(l => (l.link?.kind === 'item' ? [l.link.id] : [])))]
  const recipeIds = [...new Set(d.lines.flatMap(l => (l.link?.kind === 'recipe' ? [l.link.id] : [])))]
  const [items, recipes] = await Promise.all([
    itemIds.length
      ? prisma.inventoryItem.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, isActive: true, mergedIntoId: true, baseUnit: true },
        })
      : Promise.resolve([]),
    recipeIds.length
      ? prisma.recipe.findMany({
          where: { id: { in: recipeIds } },
          select: { id: true, type: true, isActive: true, inventoryItem: { select: { baseUnit: true } } },
        })
      : Promise.resolve([]),
  ])
  const baseUnits = new Map<string, string | null>()
  for (const it of items) if (it.isActive && !it.mergedIntoId) baseUnits.set(`item:${it.id}`, it.baseUnit)
  for (const r of recipes) if (r.type === 'PREP' && r.isActive) baseUnits.set(`recipe:${r.id}`, r.inventoryItem?.baseUnit ?? null)
  const gone = d.lines.find(l => l.link && !baseUnits.has(`${l.link.kind}:${l.link.id}`))
  if (gone?.link) {
    return NextResponse.json(
      { error: `${gone.link.name} is no longer in the list — pick again for "${gone.raw}".` },
      { status: 409 },
    )
  }
  const baseUnitOf = (l: DraftLine) => (l.link ? baseUnits.get(`${l.link.kind}:${l.link.id}`) ?? null : null)
  const rows = ingredientRows(d, baseUnitOf)
  const aliases = aliasLearnings(d)
  const measures = countMeasureLearnings(d)

  let saved: { recipeId: string; inventoryItemId: string }
  try {
    saved = await prisma.$transaction(async tx => {
      const claim = await tx.recipeScanDraft.updateMany({
        where: { id: draft.id, status: 'OPEN' },
        data: { status: 'SAVED' },
      })
      if (claim.count === 0) throw new AlreadySaved()

      const recipe = await tx.recipe.create({
        data: {
          name,
          type: 'PREP',
          categoryId: category.id,
          baseYieldQty,
          yieldUnit,
          isActive: true,
          revenueCenterId: d.revenueCenterId || null,
          steps: [],
          ...(v.method.length ? { method: v.method as unknown as Prisma.InputJsonValue } : {}),
          sourceScanId: draft.scanId,
        },
      })
      const inv = await linkPrepInventoryItem(tx, { recipeId: recipe.id, name, yieldUnit, baseYieldQty })

      if (rows.length) {
        await tx.recipeIngredient.createMany({ data: rows.map(r => ({ ...r, recipeId: recipe.id })) })
      }

      const now = new Date()
      for (const a of aliases) {
        const target = {
          inventoryItemId: a.kind === 'item' ? a.id : null,
          linkedRecipeId: a.kind === 'recipe' ? a.id : null,
        }
        await tx.recipeTextAlias.upsert({
          where: { text: a.text },
          create: { text: a.text, ...target, useCount: 1, lastUsed: now },
          update: { ...target, useCount: { increment: 1 }, lastUsed: now },
        })
      }
      for (const m of measures) {
        await tx.itemCountMeasure.upsert({
          where: { inventoryItemId_word: { inventoryItemId: m.inventoryItemId, word: m.word } },
          create: m,
          update: { qty: m.qty, unit: m.unit },
        })
      }

      // The draft keeps exactly what was saved (the body), not an older autosave.
      await tx.recipeScanDraft.update({
        where: { id: draft.id },
        data: { data: d as unknown as Prisma.InputJsonValue, savedRecipeId: recipe.id, title: name },
      })
      return { recipeId: recipe.id, inventoryItemId: inv.id }
    }, { timeout: 20000 })
  } catch (e) {
    if (e instanceof AlreadySaved) return NextResponse.json({ error: ALREADY }, { status: 409 })
    throw e
  }

  // The usual PREP side effects (cost onto its item, prep list row) — as POST /api/recipes.
  await resyncPrepRecipe(saved.recipeId).catch(e => console.error('[recipe-scan save] resync', e))
  await syncPrepItemFromRecipe(saved.recipeId).catch(e => console.error('[recipe-scan save] prep-item sync', e))
  await rematchOpenDrafts(draft.scanId, draft.id).catch(e => console.error('[recipe-scan save] rematch siblings', e))

  return NextResponse.json(saved, { status: 201 })
}
