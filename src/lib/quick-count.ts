import 'server-only'
import { prisma } from '@/lib/prisma'
import { computeExpectedForItem } from '@/lib/count-expected'
import { finalizeCountSession, type FinalizeSummary } from '@/lib/count-finalize'
import { assertCountableUom, countDimsOf, CountUomError } from '@/lib/count-uom'
import { asChainItem, pricePerBaseUnit } from '@/lib/item-model'

export type QuickCountResult =
  | { ok: true; sessionId: string; expectedBase: number; summary: FinalizeSummary }
  /** `message`/`itemName` are present only for an invalid count unit, so the
   *  quick-count route can return the same body it always did. */
  | { ok: false; status: number; error: string; message?: string; itemName?: string }

/**
 * Record a single-item count as a 1-line, auto-finalized QUICK CountSession, so
 * it carries full snapshot + variance + allocation behaviour for free.
 *
 * Lifted verbatim out of POST /api/inventory/count/[id]/quick (which now calls
 * it) so the item-merge route can record a combined on-hand the same way. The
 * caller owns auth and body validation; this owns everything from the item read
 * through finalize.
 */
export async function recordQuickCount(a: {
  itemId: string
  countedQty: number
  selectedUom: string
  rcId: string
  countedBy: string
}): Promise<QuickCountResult> {
  const item = await prisma.inventoryItem.findUnique({ where: { id: a.itemId } })
  if (!item) return { ok: false, status: 404, error: 'Not found' }

  // Validate the unit BEFORE creating anything — finalize would reject it anyway,
  // but by then the session row exists and is orphaned in a never-finalized state.
  // Freezing the base here also makes this line chain-edit-proof from birth.
  let uomFactor: number
  try { uomFactor = assertCountableUom(a.selectedUom, countDimsOf(item)) }
  catch (e) {
    if (e instanceof CountUomError) {
      return { ok: false, status: 400, error: 'Invalid count unit', message: e.message, itemName: item.itemName }
    }
    throw e
  }

  const expected = await computeExpectedForItem(a.itemId, a.rcId)
  if (!expected) return { ok: false, status: 404, error: 'Not found' }

  const session = await prisma.countSession.create({
    data: {
      label:           `Quick count: ${item.itemName}`,
      sessionDate:     new Date(),
      type:            'QUICK',
      revenueCenterId: a.rcId,
      countedBy:       a.countedBy,
      lines: {
        create: [{
          inventoryItemId: item.id,
          expectedQty:     expected.expectedBase,
          countedQty:      a.countedQty,
          selectedUom:     a.selectedUom,
          countedQtyBase:  a.countedQty * uomFactor,
          priceAtCount:    pricePerBaseUnit(asChainItem(item)),
          sortOrder:       0,
        }],
      },
    },
  })

  const result = await finalizeCountSession(session.id)
  if (!result.ok) return { ok: false, status: result.status, error: result.error }

  return { ok: true, sessionId: session.id, expectedBase: expected.expectedBase, summary: result.summary }
}
