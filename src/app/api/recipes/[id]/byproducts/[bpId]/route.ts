import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { fetchRecipeWithCost, resyncPrepRecipe } from '@/lib/recipeCosts'
import { assertKnownUnit, UnitError } from '@/lib/uom'
import { requireSession, AuthError } from '@/lib/auth'
import { byproductError, creditGuard } from '@/lib/recipe-byproduct-guard'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string; bpId: string } }

async function gate(): Promise<NextResponse | null> {
  try { await requireSession('MANAGER'); return null }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}

/** The row, only if it belongs to this recipe. */
async function findRow({ params }: Ctx) {
  const row = await prisma.recipeByproduct.findUnique({ where: { id: params.bpId } })
  return row && row.recipeId === params.id ? row : null
}

// PATCH — change how much comes off (qty / unit), its note, or its order.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const denied = await gate()
  if (denied) return denied
  const row = await findRow(ctx)
  if (!row) return byproductError('NOT_FOUND', 'By-product not found', 404)

  const body = (await req.json()) ?? {}
  let qty: number | undefined
  if (body.qty !== undefined) {
    qty = Number(body.qty)
    if (!(qty > 0)) return byproductError('BAD_QTY', 'Enter how much comes off the batch.')
  }
  let unit: string | undefined
  if (body.unit !== undefined) {
    try { unit = assertKnownUnit(body.unit, 'by-product unit') }
    catch (e) { if (e instanceof UnitError) return byproductError('BAD_UNIT', e.message); throw e }
  }

  if (qty !== undefined || unit !== undefined) {
    const refused = await creditGuard(row.recipeId, rows => rows.map(r => r.id !== row.id ? r : {
      ...r,
      ...(qty !== undefined ? { qty: new Prisma.Decimal(qty) } : {}),
      ...(unit !== undefined ? { unit } : {}),
    }))
    if (refused) return refused
  }

  await prisma.recipeByproduct.update({
    where: { id: row.id },
    data: {
      ...(qty !== undefined ? { qty } : {}),
      ...(unit !== undefined ? { unit } : {}),
      ...(body.notes !== undefined ? { notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null } : {}),
      ...(typeof body.sortOrder === 'number' ? { sortOrder: body.sortOrder } : {}),
    },
  })

  await resyncPrepRecipe(row.recipeId).catch(e => console.error('[byproduct PATCH] resync', e))
  return NextResponse.json(await fetchRecipeWithCost(row.recipeId, { basis: 'AVG_30D' }))
}

// DELETE — taking a by-product off only ever raises the batch cost, so no guard.
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const denied = await gate()
  if (denied) return denied
  const row = await findRow(ctx)
  if (!row) return byproductError('NOT_FOUND', 'By-product not found', 404)

  await prisma.recipeByproduct.delete({ where: { id: row.id } })
  await resyncPrepRecipe(row.recipeId).catch(e => console.error('[byproduct DELETE] resync', e))
  return NextResponse.json(await fetchRecipeWithCost(row.recipeId, { basis: 'AVG_30D' }))
}
