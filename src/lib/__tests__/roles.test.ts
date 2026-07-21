import { describe, it, expect } from 'vitest'
import { ROLE_RANK, atLeast, assignableLevels, ROLE_LABELS, ROLE_ORDER } from '../roles'

describe('ROLE_RANK', () => {
  it('orders STAFF < LEAD < MANAGER < ADMIN < OWNER', () => {
    expect(ROLE_RANK.STAFF).toBeLessThan(ROLE_RANK.LEAD)
    expect(ROLE_RANK.LEAD).toBeLessThan(ROLE_RANK.MANAGER)
    expect(ROLE_RANK.MANAGER).toBeLessThan(ROLE_RANK.ADMIN)
    expect(ROLE_RANK.ADMIN).toBeLessThan(ROLE_RANK.OWNER)
  })
})

describe('atLeast', () => {
  it('lets OWNER pass every existing gate', () => {
    expect(atLeast('OWNER', 'ADMIN')).toBe(true)
    expect(atLeast('OWNER', 'MANAGER')).toBe(true)
  })
  it('keeps LEAD below MANAGER so existing manager gates are unchanged', () => {
    expect(atLeast('LEAD', 'MANAGER')).toBe(false)
    expect(atLeast('LEAD', 'ADMIN')).toBe(false)
  })
  it('lets LEAD pass a LEAD gate but not STAFF pass it', () => {
    expect(atLeast('LEAD', 'LEAD')).toBe(true)
    expect(atLeast('STAFF', 'LEAD')).toBe(false)
  })
  it('is reflexive', () => {
    for (const r of ROLE_ORDER) expect(atLeast(r, r)).toBe(true)
  })
})

describe('assignableLevels', () => {
  it('never offers OWNER to anyone', () => {
    for (const r of ROLE_ORDER) expect(assignableLevels(r)).not.toContain('OWNER')
  })
  it('lets OWNER and ADMIN assign every non-owner level', () => {
    expect(assignableLevels('OWNER')).toEqual(['ADMIN', 'MANAGER', 'LEAD', 'STAFF'])
    expect(assignableLevels('ADMIN')).toEqual(['ADMIN', 'MANAGER', 'LEAD', 'STAFF'])
  })
  it('limits MANAGER to LEAD and STAFF', () => {
    expect(assignableLevels('MANAGER')).toEqual(['LEAD', 'STAFF'])
  })
  it('gives LEAD and STAFF nothing', () => {
    expect(assignableLevels('LEAD')).toEqual([])
    expect(assignableLevels('STAFF')).toEqual([])
  })
})

describe('ROLE_LABELS', () => {
  it('calls LEAD "Shift Lead"', () => {
    expect(ROLE_LABELS.LEAD).toBe('Shift Lead')
  })
})
