import { describe, it, expect } from 'vitest'
import { parseProgress, isEmptyProgress, stepKeyAt, toggleKey, EMPTY_PROGRESS } from '../prep-progress'

describe('parseProgress: what the API stores on the live log', () => {
  it('null / non-objects → null', () => {
    expect(parseProgress(null)).toBeNull()
    expect(parseProgress(undefined)).toBeNull()
    expect(parseProgress('x')).toBeNull()
    expect(parseProgress([1])).toBeNull()
  })
  it('sanitises: finite positive makeQty, string keys deduped, junk dropped', () => {
    expect(parseProgress({ makeQty: 3.5, ingredients: ['a', 'a', 2, ''], steps: ['k1'] }))
      .toEqual({ makeQty: 3.5, ingredients: ['a'], steps: ['k1'] })
    expect(parseProgress({ makeQty: 0 })).toEqual({ makeQty: null, ingredients: [], steps: [] })
    expect(parseProgress({ makeQty: 'abc', ingredients: 'no' })).toEqual({ makeQty: null, ingredients: [], steps: [] })
  })
})

describe('isEmptyProgress', () => {
  it('nothing ticked and no scale = empty', () => {
    expect(isEmptyProgress(EMPTY_PROGRESS)).toBe(true)
    expect(isEmptyProgress({ makeQty: 2, ingredients: [], steps: [] })).toBe(false)
    expect(isEmptyProgress({ makeQty: null, ingredients: ['a'], steps: [] })).toBe(false)
  })
})

describe('stepKeyAt: method steps by key, legacy steps by index', () => {
  it('uses the method step key when there is one', () => {
    expect(stepKeyAt([{ key: 'm1', text: 'Mix' }, { key: 'm2', text: 'Bake' }], 1)).toBe('m2')
  })
  it('falls back to a stable index key', () => {
    expect(stepKeyAt(null, 3)).toBe('s3')
    expect(stepKeyAt([{ key: 'm1', text: 'Mix' }], 5)).toBe('s5')
  })
})

describe('toggleKey', () => {
  it('adds when absent, removes when present, never duplicates', () => {
    expect(toggleKey([], 'a')).toEqual(['a'])
    expect(toggleKey(['a'], 'a')).toEqual([])
    expect(toggleKey(['a', 'b'], 'a')).toEqual(['b'])
  })
})
