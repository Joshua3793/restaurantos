import { describe, it, expect } from 'vitest'
import { receivedViaLabel, receivedNote } from '@/lib/invoice/received-copy'

describe('received-copy', () => {
  it('labels each provenance in plain words; the pack paths need no label', () => {
    expect(receivedViaLabel('billed-weight')).toBe('billed weight')
    expect(receivedViaLabel('shipped-unit')).toBe('shipped by weight')
    expect(receivedViaLabel('rate')).toBe('billed weight')
    expect(receivedViaLabel('frozen')).toBe(null)
    expect(receivedViaLabel('printed-pack')).toBe(null)
    expect(receivedViaLabel('item-pack')).toBe(null)
    expect(receivedViaLabel('none')).toBe(null)
  })
  it('warns when a weight could not be converted', () => {
    expect(receivedNote({ via: 'item-pack', needsBridge: true }))
      .toBe('Billed by weight, but this item has no weight per each — received through its pack instead.')
    expect(receivedNote({ via: 'billed-weight', needsBridge: false })).toBe(null)
  })
})
