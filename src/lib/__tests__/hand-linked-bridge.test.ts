// C1 (task-2-fix1.md): a HAND-LINKED line used to reach the receiving rule with
// no bridges and no supplier offers, because `matchPatchFromResult`'s staged
// patch is deliberately partial (InventorySearchResult carries neither), and
// nothing dropped it once the link was actually persisted.
//
// composites.tsx has 'use client' JSX and cannot be imported into this
// node-environment vitest run — importing it fails at Vite's import-analysis
// step ("Failed to parse source ... contains invalid JS syntax", because
// tsconfig.json's `"jsx": "preserve"` needs @vitejs/plugin-react, which is not
// wired into vitest.config.ts). So the two snippets below are literal mirrors of
// the real code, cited by file:line, not reimplemented behaviour:
//
//   stagedMatchPatch  mirrors matchPatchFromResult (composites.tsx:45-66)
//   effectiveLineOf   mirrors getEffectiveLine (InvoiceReviewDrawer.tsx:717-722)
//   dropMatchedItemKey mirrors dropStagedMatchedItem (InvoiceReviewDrawer.tsx:1014-1024)
//
// The fix (linkExistingItem, InvoiceReviewDrawer.tsx:1035-1040) is: updateLine →
// await flushPendingEdits() → dropStagedMatchedItem(id) → await
// refreshSession(id). This test proves the INVARIANT that fix depends on: once
// the staged matchedItem is dropped, getEffectiveLine's merge falls through to
// the server row (the refreshed session, which spreads ...PRICING_SELECT +
// supplierPrices — verified in the Task 2 report), and that row carries the
// bridge the partial patch never did.
import { describe, it, expect } from 'vitest'
import { matchedLikeOf } from '@/lib/invoice/matched-like'
import type { InventoryMatch, ScanItem } from '@/components/invoices/types'

interface SearchHit {
  id: string; itemName: string; purchasePrice: number; pricePerBaseUnit: number; baseUnit: string
  dimension?: string; packChain?: unknown; pricing?: unknown; countUnit?: string | null
}

// Mirrors matchPatchFromResult (composites.tsx:45-66) EXACTLY: InventorySearchResult
// carries no eachMeasure/density/supplierPrices, so neither does this patch.
function stagedMatchPatch(hit: SearchHit): Partial<ScanItem> {
  return {
    matchedItemId: hit.id,
    matchedItem: {
      id: hit.id,
      itemName: hit.itemName,
      purchasePrice: String(hit.purchasePrice),
      pricePerBaseUnit: String(hit.pricePerBaseUnit),
      baseUnit: hit.baseUnit,
      dimension: hit.dimension,
      packChain: hit.packChain,
      pricing: hit.pricing,
      countUnit: hit.countUnit,
    } as InventoryMatch,
    action: 'UPDATE_PRICE',
    matchConfidence: 'HIGH',
    matchScore: 100,
  }
}

// Mirrors getEffectiveLine (InvoiceReviewDrawer.tsx:717-722): staged edits layered OVER the server row.
const effectiveLineOf = (base: ScanItem, edits: Partial<ScanItem> | undefined): ScanItem =>
  edits ? { ...base, ...edits } : base

// Mirrors dropStagedMatchedItem (InvoiceReviewDrawer.tsx:1014-1024): drops JUST
// the staged matchedItem key, keeping any other staged edit for the line.
function dropMatchedItemKey(edits: Partial<ScanItem>): Partial<ScanItem> {
  const { matchedItem: _drop, ...keep } = edits
  return keep
}

describe('C1 — a hand-linked line reaches the rule with no bridges until the staged patch is dropped', () => {
  const hit: SearchHit = {
    id: 'item-1', itemName: 'Eggplant', purchasePrice: 70.3, pricePerBaseUnit: 2.93, baseUnit: 'each',
    dimension: 'COUNT', packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 }, countUnit: 'each',
  }

  // The refreshed session AFTER the PATCH lands — the full ...PRICING_SELECT +
  // supplierPrices row (session GET route, verified in the Task 2 report).
  const serverRow = {
    id: 'scan-1', matchedItemId: 'item-1',
    matchedItem: {
      id: 'item-1', itemName: 'Eggplant', dimension: 'COUNT', baseUnit: 'each',
      packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 },
      countUnit: 'each', eachMeasureQty: '181.4368', eachMeasureUnit: 'g',
      pricePerBaseUnit: '2.93', purchasePrice: '70.3',
      supplierPrices: [],
    } as unknown as InventoryMatch,
  } as unknown as ScanItem

  it('BEFORE the drop: the staged partial patch shadows the server row — no bridge, needsBridge stays true', () => {
    const staged = stagedMatchPatch(hit)
    const effective = effectiveLineOf(serverRow, staged)
    const like = matchedLikeOf(effective.matchedItem!)
    expect(like.eachMeasureQty).toBeFalsy()
  })

  it('AFTER linkExistingItem drops the staged matchedItem post-persist: the effective line reads the full server row and carries the bridge', () => {
    const staged = stagedMatchPatch(hit)
    const dropped = dropMatchedItemKey(staged)   // what dropStagedMatchedItem does
    const effective = effectiveLineOf(serverRow, dropped)
    // matchedItemId (and any other staged field) survives the drop — only the
    // partial matchedItem snapshot is removed.
    expect(effective.matchedItemId).toBe('item-1')
    const like = matchedLikeOf(effective.matchedItem!)
    expect(like.eachMeasureQty).toBe('181.4368')
    expect(like.eachMeasureUnit).toBe('g')
  })
})
