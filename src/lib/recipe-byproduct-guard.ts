import { NextResponse } from 'next/server'
import { fetchRecipeWithCost, type ByproductCostRow } from '@/lib/recipeCosts'
import { creditGuardMessage } from '@/lib/recipe-byproducts'

/** A by-product write refused: `{ error, code }` — the editor shows `error` under the row. */
export function byproductError(code: string, error: string, status = 400) {
  return NextResponse.json({ error, code }, { status })
}

/**
 * Cost the recipe as if its by-products were `edit(rows)` and refuse when the
 * credits would be more than the ingredients cost. Costed on the stored
 * (last-price) basis — the number every dish built on this prep reads.
 * Returns the refusal, or null when the write may go ahead.
 */
export async function creditGuard(
  recipeId: string,
  edit: (rows: ByproductCostRow[]) => ByproductCostRow[],
): Promise<NextResponse | null> {
  const preview = await fetchRecipeWithCost(recipeId, { editByproducts: edit })
  if (!preview?.creditExceedsCost) return null
  // A batch that is ALREADY over-credited (an ingredient or price changed under
  // it) may still come down step by step — refusing every edit that leaves it
  // over would block the very fix the red line asks for.
  const now = await fetchRecipeWithCost(recipeId)
  if (now && preview.byproductCredit < now.byproductCredit) return null
  return byproductError('CREDIT_EXCEEDS', creditGuardMessage(preview.byproductCredit, preview.grossCost))
}
