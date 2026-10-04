import { describe, it, expect, vi, beforeEach } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prismaMock = vi.hoisted(() => ({}) as any)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
import { coverageScore, matchSupplierByName } from '@/lib/supplier-matcher'

describe('coverageScore — token coverage of the shorter name in the longer', () => {
  it('ignores business suffixes and case: "SYSCO" vs "Sysco Foods Inc" → 1', () => {
    expect(coverageScore('SYSCO', 'Sysco Foods Inc')).toBe(1)
  })
  it("the live orphan: \"Independent (Hector's YIG Garibaldi Highlands)\" vs the YIG alias → ≥ 0.5", () => {
    expect(coverageScore("Independent (Hector's YIG Garibaldi Highlands)", "Independent (Your Independent Grocer) — Hector's VIG Garibaldi Highlands")).toBeGreaterThanOrEqual(0.5)
  })
  it('unrelated names → 0', () => {
    expect(coverageScore('Premium Meats', 'Quality Produce')).toBe(0)
  })
})

// W6: a fuzzy supplier hit is a SUGGESTION the reviewer confirms — the spelling
// is learned when the approval goes through (or on a manual re-link), never here.
describe('matchSupplierByName', () => {
  const upsert = vi.fn(async () => ({}))
  const create = vi.fn(async () => ({}))
  const setup = (o: { exactAlias?: string | null; exactName?: string | null }) => {
    prismaMock.supplierAlias = {
      findFirst: async () => (o.exactAlias ? { supplierId: o.exactAlias } : null),
      findMany: async () => [{ supplierId: 'sysco', name: 'Sysco Foods Inc' }],
      upsert, create,
    }
    prismaMock.supplier = {
      findFirst: async () => (o.exactName ? { id: o.exactName } : null),
      findMany: async () => [{ id: 'gordon', name: 'Gordon Food Service' }],
    }
  }
  beforeEach(() => { upsert.mockClear(); create.mockClear() })

  it('an exact alias hit is exact', async () => {
    setup({ exactAlias: 'sysco' })
    expect(await matchSupplierByName('Sysco Foods Inc')).toEqual({ supplierId: 'sysco', exact: true })
  })

  it('an exact supplier-name hit is exact', async () => {
    setup({ exactName: 'gordon' })
    expect(await matchSupplierByName('Gordon Food Service')).toEqual({ supplierId: 'gordon', exact: true })
  })

  it('a fuzzy alias hit returns { exact: false } and writes no SupplierAlias', async () => {
    setup({})
    expect(await matchSupplierByName('SYSCO VANCOUVER')).toEqual({ supplierId: 'sysco', exact: false })
    expect(upsert).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('a fuzzy supplier-name hit returns { exact: false } and writes no SupplierAlias', async () => {
    setup({})
    expect(await matchSupplierByName('GORDON SERVICE')).toEqual({ supplierId: 'gordon', exact: false })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('no hit, or a blank name → null', async () => {
    setup({})
    expect(await matchSupplierByName('Premium Meats')).toBeNull()
    expect(await matchSupplierByName('  ')).toBeNull()
  })
})
