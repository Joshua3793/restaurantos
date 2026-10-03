import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
import { coverageScore } from '@/lib/supplier-matcher'

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
