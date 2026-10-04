import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// ── Fixtures ────────────────────────────────────────────────────────────────
// A scan line with every field null — each test states only what its invoice prints.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const line = (over: Row): Row => ({
  id: 'line1', action: 'UPDATE_PRICE', matchedItemId: null, matchedItem: null,
  newPrice: null, previousPrice: null, priceDiffPct: null, rawDescription: 'LINE',
  rawQty: null, rawUnit: null, rawUnitPrice: null, pricingMode: null, rawLineTotal: null,
  invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null,
  totalQty: null, totalQtyUOM: null, rate: null, rateUOM: null, qtyOrdered: null,
  revenueCenterId: null, rcSplit: null, sortOrder: 0, newItemData: null,
  matchConfidence: null, matchScore: null, supplierItemCode: null, receivedQtyBase: null,
  ...over,
})
const item = (over: Row): Row => ({
  id: 'item', itemName: 'Item', dimension: 'MASS', baseUnit: 'g', countUnit: 'kg',
  packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  ...over,
})
const sessionOf = (scanItems: Row[], over: Row = {}): Row => ({
  id: 's1', status: 'REVIEW', revenueCenterId: null, supplierName: 'Sysco', supplierId: 'sysco',
  invoiceDate: '2026-10-01', invoiceNumber: null, scanItems, ...over,
})

// Cilantro: Sysco's box is 4 × 1 lb, the invoice line prints 1 × 1 lb.
const CIL_CHAIN = [{ unit: 'case', per: 4 }, { unit: 'each', per: 453.592 }]
const cilantro = item({ id: 'cil', itemName: 'Cilantro', countUnit: 'case', packChain: CIL_CHAIN, pricing: { mode: 'PACK', purchasePrice: 30 } })
const cilBox = { id: 'box-cil', inventoryItemId: 'cil', supplierId: 'sysco', supplierName: 'Sysco', supplierItemCode: null, isPrimary: true,
  packChain: CIL_CHAIN, pricing: { mode: 'PACK', purchasePrice: 30 }, packQty: 4, packSize: 1, packUOM: 'lb' }
const cilLine = () => line({
  id: 'cil-line', rawDescription: 'CILANTRO CLEAN WASH FRES', matchedItemId: 'cil', matchedItem: cilantro,
  rawQty: '1', rawUnit: 'CS', rawUnitPrice: '9.5', rawLineTotal: '9.5', pricingMode: 'per_case',
  invoicePackQty: '1', invoicePackSize: '1', invoicePackUOM: 'LB',
})

// Cleveland Meats' bison: "15.775 @ $25", no unit anywhere on the line.
const bisonLine = (matchedItem: Row) => line({
  id: 'bison-line', rawDescription: 'BISON BURGER', matchedItemId: 'bison', matchedItem,
  rawQty: '15.775', rate: '25', rawUnitPrice: '25', rawLineTotal: '394.38', pricingMode: 'per_weight',
})

// ── Prisma mock ─────────────────────────────────────────────────────────────
let session: Row
let offers: Row[] = []
let dup: Row | null = null
let onClaim: (() => void) | null = null

const fns = {
  sessionFindUnique: vi.fn(async () => session),
  sessionFindFirst:  vi.fn(async () => dup),
  sessionUpdateMany: vi.fn(async () => { onClaim?.(); return { count: 1 } }),
  sessionUpdate:     vi.fn(async (a: Row) => ({ id: a.where.id })),
  sessionCreate:     vi.fn(async () => ({ id: 'clone1' })),
  sessionFindMany:   vi.fn(async () => []),
  sessionDeleteMany: vi.fn(async () => ({ count: 0 })),
  offerFindMany:     vi.fn(async () => offers),
  offerFindFirst:    vi.fn(async () => offers.find(o => o.isPrimary) ?? null),
  offerCreate:       vi.fn(async () => ({ id: 'offer-new' })),
  offerUpdate:       vi.fn(async (a: Row) => ({ id: a.where.id })),
  scanUpdate:        vi.fn(async (a: Row) => ({ id: a.where.id })),
  scanUpdateMany:    vi.fn(async () => ({ count: 1 })),
  scanCreateMany:    vi.fn(async () => ({ count: 1 })),
  itemCreate:        vi.fn(async (a: Row) => ({ id: 'new-item', ...a.data })),
  itemUpdate:        vi.fn(async (a: Row) => ({ id: a.where.id })),
}

/** Any model/method a test does not care about resolves to an empty answer. */
const loose = () => new Proxy({}, {
  get: () => vi.fn(async (a?: Row) => (a && 'where' in a && !('data' in a) ? [] : null)),
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    invoiceSession: {
      findUnique: (...a: unknown[]) => fns.sessionFindUnique(...(a as [])),
      findFirst:  (...a: unknown[]) => fns.sessionFindFirst(...(a as [])),
      updateMany: (...a: unknown[]) => fns.sessionUpdateMany(...(a as [])),
      update:     (a: Row) => fns.sessionUpdate(a),
      create:     (...a: unknown[]) => fns.sessionCreate(...(a as [])),
      findMany:   (...a: unknown[]) => fns.sessionFindMany(...(a as [])),
      deleteMany: (...a: unknown[]) => fns.sessionDeleteMany(...(a as [])),
    },
    revenueCenter: { findFirst: async () => ({ id: 'rc-kitchen' }) },
    inventorySupplierPrice: {
      findMany:  (...a: unknown[]) => fns.offerFindMany(...(a as [])),
      findFirst: (...a: unknown[]) => fns.offerFindFirst(...(a as [])),
      create:    (...a: unknown[]) => fns.offerCreate(...(a as [])),
      update:    (a: Row) => fns.offerUpdate(a),
    },
    invoiceScanItem: {
      update:     (a: Row) => fns.scanUpdate(a),
      updateMany: (...a: unknown[]) => fns.scanUpdateMany(...(a as [])),
      createMany: (...a: unknown[]) => fns.scanCreateMany(...(a as [])),
    },
    inventoryItem: {
      create:   (a: Row) => fns.itemCreate(a),
      update:   (a: Row) => fns.itemUpdate(a),
      findMany: async () => [],
    },
    invoiceApproveUndo: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }) },
    priceAlert: { create: async () => ({}) },
    stockAllocation: loose(),
    itemRevenueCenter: loose(),
    itemSupplierAlias: loose(),
    supplier: { findUnique: async () => ({ name: session?.supplierName ?? null }) },
    recipe: { findMany: async () => [] },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}))

let pending: Promise<unknown> | null = null
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => { pending = p } }))
vi.mock('@/lib/auth', () => ({
  requireSession: async () => ({ id: 'u1', name: 'Manager', email: 'm@x', role: 'MANAGER', isActive: true }),
  AuthError: class extends Error { status = 401 },
}))
vi.mock('@/lib/rc-scope', () => ({ assertRcWritable: async () => {} }))
vi.mock('@/lib/supplier-matcher', () => ({ learnAlias: async () => {} }))
vi.mock('@/lib/invoice-matcher', () => ({ saveAlias: async () => {} }))
vi.mock('@/lib/recipeCosts', () => ({ propagatePrepCostChanges: async () => [] }))
vi.mock('@/lib/recipe-costs', () => ({ recalculateRecipeCosts: async () => [] }))
vi.mock('@/lib/primary-offer', () => ({ ensurePrimary: async () => {} }))
vi.mock('@/lib/theoretical-cache', () => ({ invalidateTheoreticalCache: () => {} }))

const route = await import('@/app/api/invoices/sessions/[id]/approve/route')

const post = async (body: Row = {}) => {
  const req = { json: async () => body } as unknown as NextRequest
  const res = await route.POST(req, { params: { id: 's1' } })
  return { status: res.status, json: await res.json() }
}
/** Let the background approval finish. */
const settle = async () => { await pending; pending = null }

const scanUpdateFor = (id: string) => fns.scanUpdate.mock.calls.map(c => c[0] as Row).find(a => a.where.id === id)
const finalSessionWrite = () => fns.sessionUpdate.mock.calls.map(c => c[0] as Row).find(a => a.data.status === 'APPROVED')
const errorWrites = () => fns.sessionUpdate.mock.calls.map(c => c[0] as Row).filter(a => 'errorMessage' in a.data)

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockClear()
  offers = []
  dup = null
  onClaim = null
  pending = null
})

describe('approve preflight — blocked lines answer 409 and the session stays in REVIEW', () => {
  it('1. Cilantro pack disagreement → LINES_BLOCKED, nothing claimed, nothing written', async () => {
    session = sessionOf([cilLine()])
    offers = [cilBox]
    const { status, json } = await post()
    expect(status).toBe(409)
    expect(json.code).toBe('LINES_BLOCKED')
    expect(json.error).toBe("1 line can't be approved yet. Fix it, or choose “Receive the stock, keep the old price”.")
    expect(json.blocked).toHaveLength(1)
    expect(json.blocked[0]).toMatchObject({
      scanItemId: 'cil-line', description: 'CILANTRO CLEAN WASH FRES', itemName: 'Cilantro',
      reason: 'PACK_DISAGREES', canReceiveWithoutPrice: true, canConfirmPrice: false,
    })
    expect(json.blocked[0].message).toMatch(/^Sysco's box for Cilantro is a case of 4 × 1 lb/)
    expect(fns.sessionUpdateMany).not.toHaveBeenCalled()
    expect(fns.sessionUpdate).not.toHaveBeenCalled()
    expect(pending).toBeNull()
  })

  it('2. …with receiveWithoutPrice: the stock is received, no price moves, the note says so', async () => {
    session = sessionOf([cilLine()])
    offers = [cilBox]
    const { status, json } = await post({ receiveWithoutPrice: ['cil-line', 'someone-elses-line'] })
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true, queued: true })
    await settle()
    const upd = scanUpdateFor('cil-line')!
    expect(upd.data.approved).toBe(true)
    expect(upd.data.receivedQtyBase).toBeCloseTo(453.592, 6)
    expect(fns.offerCreate).not.toHaveBeenCalled()
    expect(fns.offerUpdate).not.toHaveBeenCalled()
    expect(fns.itemUpdate).not.toHaveBeenCalled()
    expect(finalSessionWrite()!.data.errorMessage).toMatch(/received without a price change/)
    expect(finalSessionWrite()!.data.errorMessage).toMatch(/^1 line was received without a price change: Cilantro — /)
  })

  it('3. bison with no unit under a $25/kg box → approved at $25/kg, 15,775 g received', async () => {
    const bison = item({ id: 'bison', itemName: 'Bison burger', countUnit: 'kg', pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' } })
    const box = { id: 'box-bison', inventoryItemId: 'bison', supplierId: 'cleveland', supplierName: 'Cleveland Meats', supplierItemCode: null, isPrimary: true,
      packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' }, packQty: null, packSize: null, packUOM: null }
    session = sessionOf([bisonLine(bison)], { supplierId: 'cleveland', supplierName: 'Cleveland Meats' })
    offers = [box]
    const { status } = await post()
    expect(status).toBe(200)
    await settle()
    expect(scanUpdateFor('bison-line')!.data.receivedQtyBase).toBeCloseTo(15775, 6)
    const offerWrite = fns.offerUpdate.mock.calls.map(c => c[0] as Row).find(a => a.where.id === 'box-bison')!
    expect(offerWrite.data.pricing).toEqual({ mode: 'RATE', rate: 25, rateUnit: 'kg' })
    expect(finalSessionWrite()!.data.errorMessage).toBeUndefined()
  })

  it('4. bison under a PACK box on an item counted in g at $0.025/g → PRICE_IMPLAUSIBLE; confirmed → written', async () => {
    const bison = item({ id: 'bison', itemName: 'Bison burger', countUnit: 'g', pricing: { mode: 'PACK', purchasePrice: 25 } })
    const box = { id: 'box-bison', inventoryItemId: 'bison', supplierId: 'cleveland', supplierName: 'Cleveland Meats', supplierItemCode: null, isPrimary: true,
      packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 25 }, packQty: null, packSize: null, packUOM: null }
    session = sessionOf([bisonLine(bison)], { supplierId: 'cleveland', supplierName: 'Cleveland Meats' })
    offers = [box]

    const first = await post()
    expect(first.status).toBe(409)
    expect(first.json.blocked).toHaveLength(1)
    expect(first.json.blocked[0]).toMatchObject({ reason: 'PRICE_IMPLAUSIBLE', canConfirmPrice: true, canReceiveWithoutPrice: true })
    expect(fns.sessionUpdateMany).not.toHaveBeenCalled()

    const second = await post({ priceConfirmed: ['bison-line'] })
    expect(second.status).toBe(200)
    await settle()
    const offerWrite = fns.offerUpdate.mock.calls.map(c => c[0] as Row).find(a => a.where.id === 'box-bison')!
    expect(offerWrite.data.pricing).toEqual({ mode: 'RATE', rate: 25, rateUnit: 'g' })
    expect(scanUpdateFor('bison-line')!.data.approved).toBe(true)
  })

  it('5. a create-new line never set up → CREATE_NEW_NOT_SET_UP, which receive-only cannot clear', async () => {
    session = sessionOf([line({ id: 'new-line', action: 'CREATE_NEW', rawDescription: 'OAT MILK', rawQty: '1', rawUnitPrice: '30' })])
    const first = await post()
    expect(first.status).toBe(409)
    expect(first.json.blocked[0]).toMatchObject({ scanItemId: 'new-line', reason: 'CREATE_NEW_NOT_SET_UP', canReceiveWithoutPrice: false })
    const second = await post({ receiveWithoutPrice: ['new-line'] })
    expect(second.status).toBe(409)
    expect(second.json.blocked[0].reason).toBe('CREATE_NEW_NOT_SET_UP')
    expect(second.json.error).toBe("1 line can't be approved yet. Fix it.")
    expect(fns.sessionUpdateMany).not.toHaveBeenCalled()
  })

  it('6. a priced line with no price at all (Limes) → NO_PRICE', async () => {
    const limes = item({ id: 'limes', itemName: 'Limes', dimension: 'COUNT', baseUnit: 'each', countUnit: 'case', packChain: [{ unit: 'case', per: 48 }], pricing: { mode: 'PACK', purchasePrice: 30 } })
    session = sessionOf([line({ id: 'limes-line', rawDescription: 'LIMES 48S', matchedItemId: 'limes', matchedItem: limes, rawQty: '1', rawUnit: 'CS' })], { supplierId: null })
    const { status, json } = await post()
    expect(status).toBe(409)
    expect(json.blocked[0]).toMatchObject({ scanItemId: 'limes-line', reason: 'NO_PRICE', itemName: 'Limes' })
  })

  it('7. a duplicate invoice → 409 DUPLICATE (duplicate: true kept for the client)', async () => {
    session = sessionOf([cilLine()], { invoiceNumber: '444324576' })
    offers = [cilBox]
    dup = { id: 'other', approvedAt: new Date('2026-09-30T12:00:00Z') }
    const { status, json } = await post()
    expect(status).toBe(409)
    expect(json.code).toBe('DUPLICATE')
    expect(json.duplicate).toBe(true)
    expect(fns.sessionUpdateMany).not.toHaveBeenCalled()
  })
})

describe('approve — a new product on a line moved to another revenue center (bug C)', () => {
  const NEW_DATA = JSON.stringify({
    itemName: 'Oat milk', category: 'DAIRY', dimension: 'VOLUME',
    packChain: [{ unit: 'case', per: 12 }, { unit: 'each', per: 1000 }],
    pricing: { mode: 'PACK', purchasePrice: 30 }, countUnit: 'case',
  })
  const newLine = () => line({
    id: 'new-line', action: 'CREATE_NEW', rawDescription: 'OAT MILK BARISTA', newItemData: NEW_DATA,
    rawQty: '1', rawUnit: 'CS', rawUnitPrice: '30', rawLineTotal: '30', pricingMode: 'per_case',
    invoicePackQty: '12', invoicePackSize: '1', invoicePackUOM: 'L', revenueCenterId: 'rc-catering',
  })

  it('8. the Catering copy carries the created product and its frozen receipt; the parent is flagged', async () => {
    session = sessionOf([newLine()])
    const { status } = await post()
    expect(status).toBe(200)
    await settle()
    const frozen = scanUpdateFor('new-line')!.data.receivedQtyBase
    expect(frozen).toBeCloseTo(12000, 6)
    expect(fns.scanCreateMany).toHaveBeenCalledTimes(1)
    const copies = (fns.scanCreateMany.mock.calls[0] as unknown as [Row])[0].data as Row[]
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatchObject({ sessionId: 'clone1', matchedItemId: 'new-item', revenueCenterId: 'rc-catering', approved: true })
    expect(copies[0].receivedQtyBase).toBeCloseTo(frozen, 6)
    expect(fns.scanUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ['new-line'] } }, data: { splitToSessionId: 'clone1' } })
  })

  it('9. a create-new refused mid-approval creates nothing and is not copied', async () => {
    const l = newLine()
    session = sessionOf([l])
    // The preflight saw it set up; by the time the run reads it, it is not.
    onClaim = () => { l.newItemData = null }
    const { status } = await post()
    expect(status).toBe(200)
    await settle()
    expect(fns.itemCreate).not.toHaveBeenCalled()
    expect(fns.sessionCreate).not.toHaveBeenCalled()
    expect(fns.scanCreateMany).not.toHaveBeenCalled()
    expect(scanUpdateFor('new-line')).toBeUndefined()
    expect(finalSessionWrite()!.data.errorMessage).toMatch(/^1 new product was not created — "OAT MILK BARISTA" was never set up/)
  })
})

describe('approve — the write side never leaves a delivery unreceived', () => {
  it('a line that turned blocked after the preflight is received without its price', async () => {
    // No box: the line is checked against the item's own 4 × 1 lb case. The
    // preflight sees a matching case; by the time the run reads it, it prints 1 × 1 lb.
    const l = cilLine()
    l.invoicePackQty = '4'
    session = sessionOf([l], { supplierId: null })
    onClaim = () => { l.invoicePackQty = '1' }
    const { status } = await post()
    expect(status).toBe(200)
    await settle()
    const upd = scanUpdateFor('cil-line')!
    expect(upd.data.approved).toBe(true)
    expect(upd.data.receivedQtyBase).toBeCloseTo(453.592, 6)
    expect(fns.itemUpdate).not.toHaveBeenCalled()
    expect(fns.offerCreate).not.toHaveBeenCalled()
    expect(fns.offerUpdate).not.toHaveBeenCalled()
    expect(errorWrites().some(a => /received without a price change/.test(a.data.errorMessage))).toBe(true)
  })
})
