import { describe, it, expect } from 'vitest'
import { rememberedCook } from '../prep-device'

describe('rememberedCook — My station opens on whoever used this device last', () => {
  const cooks = [{ id: 'liam' }, { id: 'anju' }]
  it('the saved cook when still on the roster', () => {
    expect(rememberedCook(cooks, 'anju')).toBe('anju')
  })
  it('the first cook when nothing is saved or the saved cook left', () => {
    expect(rememberedCook(cooks, null)).toBe('liam')
    expect(rememberedCook(cooks, 'gone')).toBe('liam')
  })
  it('null with no roster yet', () => {
    expect(rememberedCook([], 'anju')).toBeNull()
  })
})
