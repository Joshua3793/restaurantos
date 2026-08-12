import { NextRequest, NextResponse } from 'next/server'
import { fetchRecipeWithCost } from '@/lib/recipeCosts'
import { requireSession, AuthError } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  // API routes are excluded from middleware, so this has to guard itself — it
  // returns full recipe costs, which are MANAGER-grade numbers on every other surface.
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const factor = parseFloat(searchParams.get('factor') ?? '1')

  if (isNaN(factor) || factor <= 0) {
    return NextResponse.json({ error: 'Invalid factor' }, { status: 400 })
  }

  const recipe = await fetchRecipeWithCost(params.id)
  if (!recipe) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const scaled = {
    ...recipe,
    baseYieldQty: recipe.baseYieldQty * factor,
    ingredients: recipe.ingredients.map(ing => ({
      ...ing,
      qtyBase: ing.qtyBase * factor,
      lineCost: ing.lineCost * factor,
    })),
    totalCost: recipe.totalCost * factor,
    // costPerPortion stays the same (scaling doesn't change per-portion cost)
    scaleFactor: factor,
  }

  return NextResponse.json(scaled)
}
