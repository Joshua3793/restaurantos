import { describe, it, expect, vi } from 'vitest'
import { Prisma } from '@prisma/client'

// The exec module is server-only and talks to the database; only its PURE
// builders are under test here, so the heavy neighbours are stubbed.
// `db` is the fake `prisma` singleton; the exec-level tests below fill it in.
const { db, propagate } = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
  propagate: { fn: async (_ids: string[]): Promise<unknown> => [] },
}))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/recipeCosts', () => ({ propagatePrepCostChanges: (ids: string[]) => propagate.fn(ids) }))
vi.mock('@/lib/theoretical-cache', () => ({ invalidateTheoreticalCache: () => {} }))

const {
  buildManifest, undoBlocker, undoWrites, undoWriteList, writtenRows, applyWrites, invalidRefusal,
  applyRemeasure, undoRemeasure, listRemeasures,
} = await import('@/lib/remeasure-exec')
const { planRemeasure } = await import('@/lib/remeasure-plan')
type Loaded = Parameters<typeof buildManifest>[1]

/** A COUNT item (case of 12 at $40) re-measured by weight, one piece = 150 g.
 *  One box, one receipt, one count with its snapshot, one SKIPPED count with
 *  its THEORETICAL snapshot, one transfer, one RC allocation, and a session
 *  whose stored total is stale. Every field the loader fills is filled. */
function fixture(): Loaded {
  return {
    item: {
      id: 'item-1', itemName: 'Burrata', isStocked: true,
      dimension: 'COUNT', baseUnit: 'each', countUnit: 'case',
      packChain: [{ unit: 'case', per: 12 }],
      pricing: { mode: 'PACK', purchasePrice: 40 },
      eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
      stockOnHand: 36, lastCountQty: 36,
    },
    to: { dimension: 'MASS', unit: 'g' },
    bridge: { eachQty: 150, eachUnit: 'g' },
    boxes: [
      { id: 'box-sysco', supplierId: 'sup-sysco', supplierItemCode: 'BUR12', supplierName: 'Sysco', isPrimary: true, packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 }, packQty: 12, packSize: 1, packUOM: 'each' },
    ],
    receipts: [
      { id: 'r-case', rawQty: 2, rawUnit: 'cs', invoicePackQty: 12, invoicePackSize: 1, invoicePackUOM: 'each', rawUnitPrice: 40, rawLineTotal: 80, receivedQtyBase: 24,
        supplierId: 'sup-sysco', supplierName: 'SYSCO VANCOUVER', canonicalName: 'Sysco', supplierItemCode: 'BUR12' },
    ],
    counts: [
      {
        id: 'c-case', countedQty: 3, selectedUom: 'case', countedQtyBase: 36, expectedQty: 30, priceAtCount: 40 / 12,
        snapshot: { id: 'snap-1', qtyOnHand: 36, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 120 },
      },
      {
        id: 'c-skip', countedQty: null, selectedUom: 'case', countedQtyBase: null, skipped: true, expectedQty: 10, priceAtCount: 40 / 12,
        snapshot: { id: 'snap-th', qtyOnHand: 10, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 400 / 12 },
      },
    ],
    allocations: [{ revenueCenterId: 'rc-bar', quantity: 36 }],
    sessions: [
      { id: 'sess-1', totalCountedValue: 160, snapshots: [
        { id: 'snap-1', source: 'COUNTED', totalValue: 120 },
        { id: 'snap-other', source: 'COUNTED', totalValue: 50 },
      ] },
    ],
    transfers: [{ id: 't-1', quantity: 12 }],
    recipeLines: 1,
    wastageRows: 0,
  }
}

const AFTER = new Date('2026-10-04T12:00:00.000Z')

function manifestOf(input = fixture()) {
  const plan = planRemeasure(input)
  if ('error' in plan) throw new Error(plan.error)
  return buildManifest(plan, input, AFTER)
}

describe('buildManifest', () => {
  const m = manifestOf()

  it('records the factor, both measures and the instant apply stamped', () => {
    expect(m.itemId).toBe('item-1')
    expect(m.k).toBe(150)
    expect(m.from).toEqual({ dimension: 'COUNT', unit: 'each' })
    expect(m.to).toEqual({ dimension: 'MASS', unit: 'g' })
    expect(m.afterLastUpdated).toBe('2026-10-04T12:00:00.000Z')
  })

  it('captures the item before-values, bridges and stock baselines included', () => {
    expect(m.item.before).toEqual({
      dimension: 'COUNT', baseUnit: 'each',
      packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 },
      countUnit: 'case', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
      stockOnHand: 36, lastCountQty: 36,
    })
  })

  it('captures every box before-value, pack format included', () => {
    expect(m.boxes).toEqual([{
      id: 'box-sysco',
      before: { packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 }, packQty: 12, packSize: 1, packUOM: 'each' },
    }])
  })

  it('captures the frozen receipt, count, snapshot, allocation, session total and transfer', () => {
    expect(m.receipts).toEqual([{ id: 'r-case', old: 24 }])
    expect(m.counts).toEqual([
      { id: 'c-case', old: 36, priceAtCount: 40 / 12, expectedQty: 30 },
      // Its frozen quantity is empty and stays so — only its price and expected
      // quantity are restated, so only those are recorded (no `old`: undo must
      // not write that field).
      { id: 'c-skip', priceAtCount: 40 / 12, expectedQty: 10 },
    ])
    expect(m.snapshots).toEqual([
      { id: 'snap-1', before: { qtyOnHand: 36, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 120 } },
      // The theoretical snapshot: quantity, unit and $/base restated — its value is
      // not written by apply, so it is not recorded either.
      { id: 'snap-th', before: { qtyOnHand: 10, unit: 'each', pricePerBaseUnit: 40 / 12 } },
    ])
    expect(m.allocations).toEqual([{ revenueCenterId: 'rc-bar', old: 36 }])
    expect(m.sessions).toEqual([{ id: 'sess-1', old: 160 }])
    expect(m.transfers).toEqual([{ id: 't-1', old: 12 }])
  })

  it('leaves out rows the change does not move', () => {
    const input = fixture()
    input.sessions[0].totalCountedValue = 170          // already right — re-sums to 170
    input.transfers = [{ id: 't-0', quantity: 0 }]     // 0 × k = 0
    const mm = manifestOf(input)
    expect(mm.sessions).toEqual([])
    expect(mm.transfers).toEqual([])
  })

  it('is plain JSON — survives the Json column', () => {
    expect(JSON.parse(JSON.stringify(m))).toEqual(m)
  })

  it('reads Decimal-ish strings as numbers', () => {
    const input = fixture()
    input.item.stockOnHand = '36'
    input.item.lastCountQty = null
    input.item.eachMeasureQty = '150'   // Decimal-ish string, same piece weight the request names
    input.item.eachMeasureUnit = 'g'
    const mm = manifestOf(input)
    expect(mm.item.before.stockOnHand).toBe(36)
    expect(mm.item.before.lastCountQty).toBeNull()
    expect(mm.item.before.eachMeasureQty).toBe(150)
  })
})

describe('writtenRows — what apply writes', () => {
  const input = fixture()
  const plan = planRemeasure(input)
  if ('error' in plan) throw new Error(plan.error)
  const w = writtenRows(plan, input)

  it('every stock baseline is converted by the factor and WRITTEN', () => {
    // stockOnHand 36 each → 36 × 150 g.
    expect(w.stockOnHand).toBeCloseTo(5400, 9)
    expect(w.lastCountQty).toBeCloseTo(5400, 9)
    expect(w.allocations).toEqual([{ revenueCenterId: 'rc-bar', old: 36, next: 5400 }])
  })

  it('the theoretical snapshot is written with its new quantity, unit and $/base', () => {
    expect(w.unitOnly).toHaveLength(1)
    const s = w.unitOnly[0].snapshotUnitOnly!
    expect(s).toMatchObject({ id: 'snap-th', unit: 'g' })
    expect(s.qtyOnHand).toBeCloseTo(1500, 9)
    expect(s.pricePerBaseUnit * s.qtyOnHand).toBeCloseTo(400 / 12, 9)   // value unchanged
  })

  it('the count snapshot keeps its count-time value, its $/base ÷ k', () => {
    const s = w.snapshots[0].snapshot!
    expect(s.qtyOnHand).toBeCloseTo(5400, 9)
    expect(s.totalValue).toBeCloseTo(120, 9)
    expect(s.pricePerBaseUnit).toBeCloseTo(40 / 12 / 150, 12)
  })

  it('the receipt the old measure could read is converted by the factor', () => {
    expect(w.receipts).toHaveLength(1)
    expect(w.receipts[0].next).toBeCloseTo(3600, 9)
    expect(w.receipts[0]).toMatchObject({ how: 'converted', scaled: false })
  })

  it('every count line\'s expected quantity is written in the new base', () => {
    const lines = applyWrites(plan, input, AFTER).filter((x) => x.table === 'countLine')
    expect(lines.find((l) => l.id === 'c-case')!.data.expectedQty).toBe(4500)
    expect(lines.find((l) => l.id === 'c-skip')!.data.expectedQty).toBe(1500)
  })
})

describe('undoBlocker', () => {
  const m = manifestOf()
  const ok = { itemLastUpdated: AFTER, countLinesSince: 0 }

  it('null when nothing has happened since', () => {
    expect(undoBlocker(m, ok)).toBeNull()
  })
  it('the item changed since', () => {
    expect(undoBlocker(m, { ...ok, itemLastUpdated: new Date('2026-10-04T12:00:01.000Z') }))
      .toBe('The item has changed since — undo is no longer safe.')
  })
  it('a count was recorded since', () => {
    expect(undoBlocker(m, { ...ok, countLinesSince: 1 })).toBe('A count was recorded since — undo is no longer safe.')
  })
  it('another item was merged into it since', () => {
    expect(undoBlocker(m, { ...ok, mergesSince: 1 })).toBe('Another item was merged into it since — undo is no longer safe.')
  })
  it('a supplier box was added since', () => {
    expect(undoBlocker(m, { ...ok, boxesAdded: 1 })).toBe('A supplier box was added since — undo is no longer safe.')
  })
  it('the item is on a count that is still open', () => {
    expect(undoBlocker(m, { ...ok, inOpenCount: true }))
      .toBe('This item is on a count that is still open. Finalize or discard it first.')
  })
  it('writes the item row cannot see: a box edited, a delivery approved, stock moved', () => {
    expect(undoBlocker(m, { ...ok, boxesChanged: 1 })).toBe('The item has changed since — undo is no longer safe.')
    expect(undoBlocker(m, { ...ok, receiptsSince: 1 })).toBe('A delivery was received since — undo is no longer safe.')
    expect(undoBlocker(m, { ...ok, transfersSince: 2 })).toBe('Stock was moved since — undo is no longer safe.')
    expect(undoBlocker(m, { ...ok, boxesChanged: 0, receiptsSince: 0, transfersSince: 0 })).toBeNull()
  })
})

describe('undoWrites', () => {
  const m = manifestOf()
  const NOW = new Date('2026-10-05T09:00:00.000Z')
  const w = undoWrites(m, NOW)

  it('restores the item, bridges and stock included, and bumps lastUpdated', () => {
    expect(w.item).toEqual({
      id: 'item-1',
      data: {
        dimension: 'COUNT', baseUnit: 'each',
        packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 },
        countUnit: 'case', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
        stockOnHand: 36, lastCountQty: 36, lastUpdated: NOW,
      },
    })
  })

  it('restores boxes with their pack format, and stamps them', () => {
    expect(w.boxes).toEqual([{
      id: 'box-sysco',
      data: { packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 }, packQty: 12, packSize: 1, packUOM: 'each', lastUpdated: NOW },
    }])
  })

  it('a box that had no chain gets Json null back, not a JS null', () => {
    const mm = { ...m, boxes: [{ id: 'b', before: { packChain: null, pricing: null, packQty: null, packSize: null, packUOM: null } }] }
    expect(undoWrites(mm, NOW).boxes[0].data).toEqual({
      packChain: Prisma.DbNull, pricing: Prisma.DbNull, packQty: null, packSize: null, packUOM: null, lastUpdated: NOW,
    })
  })

  it('restores every frozen row', () => {
    expect(w.receipts).toEqual([{ id: 'r-case', data: { receivedQtyBase: 24 } }])
    expect(w.counts).toEqual([
      { id: 'c-case', data: { countedQtyBase: 36, priceAtCount: 40 / 12, expectedQty: 30 } },
      { id: 'c-skip', data: { priceAtCount: 40 / 12, expectedQty: 10 } },
    ])
    expect(w.snapshots).toEqual([
      { id: 'snap-1', data: { qtyOnHand: 36, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 120 } },
      { id: 'snap-th', data: { qtyOnHand: 10, unit: 'each', pricePerBaseUnit: 40 / 12 } },
    ])
    expect(w.allocations).toEqual([{ revenueCenterId: 'rc-bar', data: { quantity: 36 } }])
    expect(w.sessions).toEqual([{ id: 'sess-1', data: { totalCountedValue: 160 } }])
    expect(w.transfers).toEqual([{ id: 't-1', data: { quantity: 12 } }])
  })

  it('a count line with no frozen price keeps the one it has', () => {
    const mm = { ...m, counts: [{ id: 'c', old: null, priceAtCount: null }] }
    expect(undoWrites(mm, NOW).counts).toEqual([{ id: 'c', data: { countedQtyBase: null } }])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Apply ⇄ undo symmetry: every field apply writes has its before-value in the
// manifest and is put back by undo — and undo writes nothing apply did not.
// ─────────────────────────────────────────────────────────────────────────────

/** Bookkeeping stamps both directions write with their own instant — not data. */
const STAMPS = new Set(['lastUpdated', 'updatedAt'])
type Write = { table: string; id: string; data: Record<string, unknown> }
const triples = (ws: Write[]) =>
  ws.flatMap((w) => Object.keys(w.data).filter((f) => !STAMPS.has(f)).map((f) => `${w.table}|${w.id}|${f}`)).sort()

const norm = (v: unknown) =>
  typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v ?? null

/** The loaded value a write's field had BEFORE apply. */
function beforeOf(input: Loaded, table: string, id: string, field: string): unknown {
  const pick = (row: object | null | undefined) => {
    if (!row) throw new Error(`no loaded ${table} row ${id}`)
    return (row as Record<string, unknown>)[field]
  }
  switch (table) {
    case 'inventoryItem': return pick(input.item)
    case 'inventorySupplierPrice': return pick(input.boxes.find((b) => b.id === id))
    case 'invoiceScanItem': return pick(input.receipts.find((r) => r.id === id))
    case 'countLine': return pick(input.counts.find((c) => c.id === id))
    case 'inventorySnapshot':
      return pick(input.counts.find((c) => c.snapshot?.id === id)?.snapshot ?? input.straySnapshots?.find((x) => x.id === id))
    case 'stockAllocation': return pick(input.allocations.find((a) => a.revenueCenterId === id))
    case 'countSession': return pick(input.sessions.find((s) => s.id === id))
    case 'stockTransfer': return pick(input.transfers.find((t) => t.id === id))
    default: throw new Error(`unknown table ${table}`)
  }
}

describe('applyWrites ⇄ buildManifest ⇄ undoWrites', () => {
  const variants: [string, () => Loaded][] = [
    ['the fixture (pieces → weight, every row kind)', fixture],
    ['nothing on hand (stock baselines do not move)', () => {
      const input = fixture()
      input.item.stockOnHand = 0
      input.item.lastCountQty = null
      input.allocations = [{ revenueCenterId: 'rc-bar', quantity: 0 }]
      input.transfers = [{ id: 't-0', quantity: 0 }]
      return input
    }],
    ['a skipped line holding its expected quantity in the base unit', () => {
      const input = fixture()
      input.counts[1] = { ...input.counts[1], countedQty: 10, selectedUom: 'each', countedQtyBase: 10 }
      return input
    }],
    ['a second count value on one count (after a merge)', () => {
      const input = fixture()
      input.straySnapshots = [{ id: 'snap-dup', qtyOnHand: 12, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 40 }]
      return input
    }],
  ]

  for (const [name, make] of variants) {
    it(`${name}: the same (table, id, field) set both ways, each restored to its loaded value`, () => {
      const input = make()
      const plan = planRemeasure(input)
      if ('error' in plan) throw new Error(plan.error)
      const applied = applyWrites(plan, input, AFTER) as Write[]
      const undone = undoWriteList(buildManifest(plan, input, AFTER), new Date('2026-10-05T09:00:00.000Z')) as Write[]

      expect(triples(undone)).toEqual(triples(applied))
      for (const w of undone) {
        for (const [field, value] of Object.entries(w.data)) {
          if (STAMPS.has(field)) continue
          const v = value === Prisma.DbNull ? null : value
          expect(norm(v), `${w.table}|${w.id}|${field}`).toEqual(norm(beforeOf(input, w.table, w.id, field)))
        }
      }
    })
  }

  it('a skipped line in the base unit writes and records its typed quantity and unit with its frozen base', () => {
    const input = fixture()
    input.counts[1] = { ...input.counts[1], countedQty: 10, selectedUom: 'each', countedQtyBase: 10 }
    const plan = planRemeasure(input)
    if ('error' in plan) throw new Error(plan.error)
    const line = (applyWrites(plan, input, AFTER) as Write[]).find((w) => w.table === 'countLine' && w.id === 'c-skip')!
    expect(line.data).toMatchObject({ countedQtyBase: 1500, countedQty: 1500, selectedUom: 'g', expectedQty: 1500 })
    expect(buildManifest(plan, input, AFTER).counts.find((c) => c.id === 'c-skip'))
      .toEqual({ id: 'c-skip', old: 10, countedQty: 10, selectedUom: 'each', priceAtCount: 40 / 12, expectedQty: 10 })
  })

  it('a second count value on one count is written in the new base and recorded', () => {
    const input = fixture()
    input.straySnapshots = [{ id: 'snap-dup', qtyOnHand: 12, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 40 }]
    const plan = planRemeasure(input)
    if ('error' in plan) throw new Error(plan.error)
    const snap = (applyWrites(plan, input, AFTER) as Write[]).find((w) => w.id === 'snap-dup')!
    expect(snap.table).toBe('inventorySnapshot')
    expect(snap.data).toMatchObject({ qtyOnHand: 1800, unit: 'g' })
    expect(buildManifest(plan, input, AFTER).snapshots.find((x) => x.id === 'snap-dup'))
      .toEqual({ id: 'snap-dup', before: { qtyOnHand: 12, unit: 'each', pricePerBaseUnit: 40 / 12 } })
  })

  it('apply stamps count lines with its own instant, so "edited since" never sees its own writes', () => {
    const input = fixture()
    const plan = planRemeasure(input)
    if ('error' in plan) throw new Error(plan.error)
    const lines = (applyWrites(plan, input, AFTER) as Write[]).filter((w) => w.table === 'countLine')
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l.data.updatedAt).toEqual(AFTER)
  })
})

describe('invalidRefusal', () => {
  it('one plain sentence on screen; the raw list only in details', () => {
    const errors = [
      'the price per unit would change — this pack cannot be converted as it is',
      'Sysco: countUnit "cs" is not a link of the packChain',
    ]
    const r = invalidRefusal(errors)
    expect(r.code).toBe('INVALID')
    expect(r.message).toBe("This change can't be applied — the new pack or price would not be valid. Check the numbers and try again.")
    expect(r.message).not.toMatch(/countUnit|packChain|chain/)
    expect(r.details).toEqual(errors)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Exec level, against a fake client
// ─────────────────────────────────────────────────────────────────────────────

describe('after the commit', () => {
  it('apply: a failed re-cost is logged, never reported as "nothing was changed"', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db.$transaction = async () => ({ remeasureId: 'rm1', plan: { summary: {} } })
    propagate.fn = async () => { throw new Error('re-cost blew up') }
    await expect(applyRemeasure({
      itemId: 'item-1', to: { dimension: 'MASS', unit: 'g' }, bridge: {}, expectedLastUpdated: AFTER.toISOString(), userId: 'u1',
    })).resolves.toEqual({ remeasureId: 'rm1', plan: { summary: {} } })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
    propagate.fn = async () => []
  })

  it('undo: a failed re-cost is logged, the undo still succeeds', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db.itemRemeasure = { findUnique: async () => ({ id: 'rm1', itemId: 'item-1', changedAt: AFTER, undoneAt: null, manifest: manifestOf() }) }
    db.$transaction = async () => undefined
    propagate.fn = async () => { throw new Error('re-cost blew up') }
    await expect(undoRemeasure('rm1')).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
    propagate.fn = async () => []
  })
})

describe('listRemeasures', () => {
  it('judges only the newest change; older ones wait for it, with no queries of their own', async () => {
    const m = manifestOf()
    const older = new Date('2026-10-03T12:00:00.000Z')
    const calls: string[] = []
    const count = (name: string, n = 0) => async (args: unknown) => { calls.push(`${name} ${JSON.stringify(args)}`); return n }
    db.itemRemeasure = {
      findMany: async () => [
        { id: 'rm-new', itemId: 'item-1', changedAt: AFTER, undoneAt: null, manifest: m },
        { id: 'rm-old', itemId: 'item-1', changedAt: older, undoneAt: null, manifest: m },
      ],
    }
    db.inventoryItem = { findUnique: async () => { calls.push('item'); return { lastUpdated: AFTER } } }
    db.inventorySupplierPrice = {
      findMany: async () => { calls.push('boxes'); return [{ lastUpdated: AFTER }] },
      count: count('boxesAdded'),
    }
    db.invoiceScanItem = { count: count('receipts') }
    db.stockTransfer = { count: count('transfers') }
    db.countLine = { count: count('countLine') }
    db.itemMerge = { count: count('merges') }

    const out = await listRemeasures('item-1')
    expect(out.map((c) => [c.id, c.canUndo, c.reason])).toEqual([
      ['rm-new', true, null],
      ['rm-old', false, 'Its measure was changed again since — undo that one first.'],
    ])
    expect(calls.filter((c) => c === 'item')).toHaveLength(1)
    // "since" is judged from the newest change's own instant
    expect(calls.some((c) => c.startsWith('merges') && c.includes('"survivorId":"item-1"') && c.includes(AFTER.toISOString()))).toBe(true)
    // count lines edited since (updatedAt), and the open-count check
    expect(calls.some((c) => c.startsWith('countLine') && c.includes('"updatedAt"'))).toBe(true)
    expect(calls.some((c) => c.startsWith('countLine') && c.includes('"FINALIZED"'))).toBe(true)
    // a box that is not in the manifest
    expect(calls.some((c) => c.startsWith('boxesAdded') && c.includes('"notIn":["box-sysco"]'))).toBe(true)
  })

  it('an open count blocks the newest change', async () => {
    db.inventoryItem = { findUnique: async () => ({ lastUpdated: AFTER }) }
    db.itemRemeasure = { findMany: async () => [{ id: 'rm-new', itemId: 'item-1', changedAt: AFTER, undoneAt: null, manifest: manifestOf() }] }
    db.countLine = { count: async (a: { where: { session?: unknown } }) => (a.where.session ? 1 : 0) }
    const out = await listRemeasures('item-1')
    expect(out[0]).toMatchObject({ canUndo: false, reason: 'This item is on a count that is still open. Finalize or discard it first.' })
  })
})
