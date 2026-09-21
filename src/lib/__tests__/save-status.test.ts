import { describe, it, expect } from 'vitest'
import { aggregateSaveResult } from '@/lib/invoice/save-status'

// The bug this guards: persistEdit used to set the save-status chip itself, per
// call, inside a Promise.all of concurrent PATCHes. Whichever call resolved LAST
// won the race — a later-resolving SUCCESS silently erased an earlier FAILURE's
// "save failed" chip, even though that earlier edit never reached the server.
// Error must win regardless of order or how many other patches in the same
// batch succeeded.
describe('aggregateSaveResult', () => {
  it('idle when every patch in the batch succeeded', () => {
    expect(aggregateSaveResult([true])).toBe('idle')
    expect(aggregateSaveResult([true, true, true])).toBe('idle')
  })

  it('error wins when any patch failed, regardless of position or how many succeeded', () => {
    expect(aggregateSaveResult([false])).toBe('error')
    expect(aggregateSaveResult([true, false])).toBe('error')
    expect(aggregateSaveResult([false, true, true])).toBe('error')
    expect(aggregateSaveResult([true, true, false])).toBe('error')
    expect(aggregateSaveResult([false, false])).toBe('error')
  })
})
