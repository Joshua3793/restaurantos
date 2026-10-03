import { describe, it, expect } from 'vitest'
import {
  allocationUpsertSql, itemCountUpdateSql, lineFinalizeUpdateSql, FinalizeValueError, FINALIZE_SQL_CHUNK,
} from '@/lib/count-finalize-sql'

const now = new Date('2026-10-03T05:38:38.488Z')
const countDate = new Date('2026-10-01T00:00:00.000Z')

describe('itemCountUpdateSql', () => {
  it('writes stockOnHand only when asked (default RC / unscoped)', () => {
    const [withStock] = itemCountUpdateSql([{ itemId: 'cmabc', qtyBase: 1500 }], { countDate, now, writeStockOnHand: true })
    const [rcOnly]    = itemCountUpdateSql([{ itemId: 'cmabc', qtyBase: 1500 }], { countDate, now, writeStockOnHand: false })
    expect(withStock).toContain('"stockOnHand" = v.qty')
    expect(rcOnly).not.toContain('stockOnHand')
    expect(withStock).toContain(`('cmabc', '1500'::numeric)`)
    expect(withStock).toContain(`"lastCountDate" = '2026-10-01 00:00:00.000'::timestamp(3)`)
    expect(withStock).toContain(`"lastUpdated" = '2026-10-03 05:38:38.488'::timestamp(3)`)
  })

  it('emits nothing for no rows', () => {
    expect(itemCountUpdateSql([], { countDate, now, writeStockOnHand: true })).toEqual([])
  })

  it('chunks large counts', () => {
    const rows = Array.from({ length: FINALIZE_SQL_CHUNK + 1 }, (_, i) => ({ itemId: `item${i}`, qtyBase: i }))
    expect(itemCountUpdateSql(rows, { countDate, now, writeStockOnHand: true })).toHaveLength(2)
  })

  it('refuses an unsafe id or a non-finite qty instead of emitting SQL', () => {
    expect(() => itemCountUpdateSql([{ itemId: "x'; DROP TABLE", qtyBase: 1 }], { countDate, now, writeStockOnHand: true }))
      .toThrow(FinalizeValueError)
    expect(() => itemCountUpdateSql([{ itemId: 'cmabc', qtyBase: NaN }], { countDate, now, writeStockOnHand: true }))
      .toThrow(FinalizeValueError)
  })
})

describe('lineFinalizeUpdateSql', () => {
  it('locks price on skipped lines and leaves their variance alone', () => {
    const [sql] = lineFinalizeUpdateSql([
      { lineId: 'line-1', priceAtCount: 0.0125, counted: null },
      { lineId: 'line-2', priceAtCount: 2, counted: { variancePct: -10, varianceCost: -4.5, countedQtyBase: 9 } },
    ], { now })
    expect(sql).toContain(`('line-1', '0.0125'::numeric, false, NULL::numeric, NULL::numeric, NULL::numeric)`)
    expect(sql).toContain(`('line-2', '2'::numeric, true, '-10'::numeric, '-4.5'::numeric, '9'::numeric)`)
    expect(sql).toContain(`"variancePct" = CASE WHEN v.counted THEN v.vpct ELSE l."variancePct" END`)
  })
})

describe('allocationUpsertSql', () => {
  it('upserts one row per item on the RC key', () => {
    let n = 0
    const [sql] = allocationUpsertSql(
      [{ itemId: 'a', qtyBase: 1 }, { itemId: 'b', qtyBase: 2 }, { itemId: 'a', qtyBase: 3 }],
      { revenueCenterId: 'rc1', now, newId: () => `new${n++}` },
    )
    expect(sql).toContain('ON CONFLICT ("revenueCenterId", "inventoryItemId")')
    // duplicate item collapsed, last line wins
    expect(sql.match(/'a'/g)).toHaveLength(1)
    expect(sql).toContain(`'rc1', 'a', '3'::numeric`)
  })
})
