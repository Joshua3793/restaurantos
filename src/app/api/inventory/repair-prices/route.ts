import { NextResponse } from 'next/server'

/**
 * POST /api/inventory/repair-prices
 *
 * DEPRECATED under the item-model chain redesign.
 *
 * This tool used to recompute `pricePerBaseUnit` for every active item via the
 * legacy purchase formula. With the chain model, `pricePerBaseUnit` is derived
 * from `packChain` + `pricing` (see src/lib/item-model.ts `pricePerBaseUnit`),
 * so a blind legacy recompute here would write a value that diverges from the
 * chain and break the parity invariant. Repair is now a no-op.
 */
export async function POST() {
  return NextResponse.json({
    deprecated: true,
    message: 'pricePerBaseUnit is now derived from packChain; repair is obsolete',
  })
}
