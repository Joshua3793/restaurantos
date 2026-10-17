import { describe, it, expect } from 'vitest'
import { parseAllergenKeys } from '@/lib/allergens'

describe('parseAllergenKeys', () => {
  it('accepts known keys and de-duplicates', () => {
    expect(parseAllergenKeys(['Milk', 'Sulphites', 'Milk'])).toEqual(['Milk', 'Sulphites'])
    expect(parseAllergenKeys([])).toEqual([])
  })
  it('rejects unknown keys, non-strings and non-arrays', () => {
    expect(parseAllergenKeys(['Milk', 'Gluten'])).toBeNull()
    expect(parseAllergenKeys([1])).toBeNull()
    expect(parseAllergenKeys('Milk')).toBeNull()
    expect(parseAllergenKeys(null)).toBeNull()
    expect(parseAllergenKeys(['constructor'])).toBeNull()
  })
})
