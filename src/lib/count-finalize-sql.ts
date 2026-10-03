import { isSafeRowId } from '@/lib/item-merge-rows'

/**
 * Set-based write SQL for count finalize (src/lib/count-finalize.ts).
 *
 * Finalize used to issue one Prisma `update`/`upsert` per line — ~900 statements
 * for a 438-line Kitchen count, plus one concurrent upsert per counted line for
 * a non-default RC. On the live pooler that ran ~80 s and the concurrent
 * upserts starved the connection pool: the request 500'd after the main
 * transaction had already committed, leaving a Catering count with 120 of 334
 * stock allocations never written and the session bounced back to review.
 * These builders collapse each per-line write into ONE statement per kind.
 *
 * Why *Unsafe* and literal: `DATABASE_URL` is a transaction-mode pooler with no
 * named prepared statements, so hand-built literal SQL is the sanctioned raw
 * path (see `lockItemsSql` in src/lib/item-merge-rows.ts). Interpolation is safe
 * only because every id passes {@link isSafeRowId} and every number is
 * checked finite — the builders THROW rather than emit SQL they cannot vouch for.
 */

/** Rows per statement — keeps each statement well under any size limit. */
export const FINALIZE_SQL_CHUNK = 500

export class FinalizeValueError extends Error {}

function id(v: string): string {
  if (!isSafeRowId(v)) throw new FinalizeValueError(`unsafe row id ${JSON.stringify(v)}`)
  return `'${v}'`
}

function num(v: number, what: string): string {
  if (!Number.isFinite(v)) throw new FinalizeValueError(`${what} is not a number (${v})`)
  return `'${v}'::numeric`
}

function numOrNull(v: number | null, what: string): string {
  return v === null ? 'NULL::numeric' : num(v, what)
}

/** Prisma stores DateTime as UTC in `timestamp(3)` (no zone). */
function ts(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new FinalizeValueError('invalid date')
  return `'${d.toISOString().replace('T', ' ').replace('Z', '')}'::timestamp(3)`
}

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += FINALIZE_SQL_CHUNK) out.push(rows.slice(i, i + FINALIZE_SQL_CHUNK))
  return out
}

export interface ItemCountWrite { itemId: string; qtyBase: number }

/**
 * Counted items: `lastCountDate` + `lastCountQty`, and `stockOnHand` too unless
 * the count is scoped to a non-default RC (whose stock lives in StockAllocation).
 */
export function itemCountUpdateSql(
  rows: ItemCountWrite[], o: { countDate: Date; now: Date; writeStockOnHand: boolean },
): string[] {
  return chunks(rows).map(part => {
    const values = part.map(r => `(${id(r.itemId)}, ${num(r.qtyBase, 'counted qty')})`).join(',\n  ')
    return `UPDATE "InventoryItem" AS i SET
  ${o.writeStockOnHand ? '"stockOnHand" = v.qty,' : ''}
  "lastCountDate" = ${ts(o.countDate)},
  "lastCountQty" = v.qty,
  "lastUpdated" = ${ts(o.now)}
FROM (VALUES
  ${values}
) AS v(id, qty)
WHERE i.id = v.id`
  })
}

export interface LineFinalizeWrite {
  lineId: string
  priceAtCount: number
  /** null on a skipped line — only its price is locked. */
  counted: { variancePct: number; varianceCost: number; countedQtyBase: number } | null
}

/** Lock each line's price; counted lines also get variance + frozen base qty. */
export function lineFinalizeUpdateSql(rows: LineFinalizeWrite[], o: { now: Date }): string[] {
  return chunks(rows).map(part => {
    const values = part.map(r => `(${id(r.lineId)}, ${num(r.priceAtCount, 'price')}, ${r.counted ? 'true' : 'false'}, ${
      numOrNull(r.counted?.variancePct ?? null, 'variance %')}, ${
      numOrNull(r.counted?.varianceCost ?? null, 'variance $')}, ${
      numOrNull(r.counted?.countedQtyBase ?? null, 'counted qty')})`).join(',\n  ')
    return `UPDATE "CountLine" AS l SET
  "priceAtCount" = v.price,
  "variancePct" = CASE WHEN v.counted THEN v.vpct ELSE l."variancePct" END,
  "varianceCost" = CASE WHEN v.counted THEN v.vcost ELSE l."varianceCost" END,
  "countedQtyBase" = CASE WHEN v.counted THEN v.base ELSE l."countedQtyBase" END,
  "updatedAt" = ${ts(o.now)}
FROM (VALUES
  ${values}
) AS v(id, price, counted, vpct, vcost, base)
WHERE l.id = v.id`
  })
}

/** Upsert the RC's allocation to the counted qty (non-default RC counts only). */
export function allocationUpsertSql(
  rows: ItemCountWrite[], o: { revenueCenterId: string; now: Date; newId: () => string },
): string[] {
  // One row per item: Postgres refuses an ON CONFLICT that hits the same key
  // twice in one statement. Last line wins, as the old sequential upserts did.
  const byItem = new Map(rows.map(r => [r.itemId, r]))
  return chunks([...byItem.values()]).map(part => {
    const values = part.map(r =>
      `(${id(o.newId())}, ${id(o.revenueCenterId)}, ${id(r.itemId)}, ${num(r.qtyBase, 'counted qty')}, ${ts(o.now)})`,
    ).join(',\n  ')
    return `INSERT INTO "StockAllocation" (id, "revenueCenterId", "inventoryItemId", quantity, "updatedAt")
VALUES
  ${values}
ON CONFLICT ("revenueCenterId", "inventoryItemId")
DO UPDATE SET quantity = EXCLUDED.quantity, "updatedAt" = EXCLUDED."updatedAt"`
  })
}
