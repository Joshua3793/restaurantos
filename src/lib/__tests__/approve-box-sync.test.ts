import { describe, it, expect } from 'vitest'
import { primaryBoxWrite } from '../invoice/reprice'

describe('primaryBoxWrite', () => {
  it('re-pricing + offer written -> the written box', () => {
    expect(primaryBoxWrite({ shouldReprice: true, writtenOfferId: 'offer-1', primaryId: 'offer-1' })).toEqual({ boxId: 'offer-1' })
  })
  it('re-pricing + offer write failed -> the primary box', () => {
    expect(primaryBoxWrite({ shouldReprice: true, writtenOfferId: null, primaryId: 'offer-9' })).toEqual({ boxId: 'offer-9' })
  })
  it('re-pricing + no box at all (legacy item) -> nothing to write', () => {
    expect(primaryBoxWrite({ shouldReprice: true, writtenOfferId: null, primaryId: null })).toEqual({ boxId: null })
  })
  it('non-primary line (not re-pricing) -> nothing, even with a written box', () => {
    expect(primaryBoxWrite({ shouldReprice: false, writtenOfferId: 'offer-2', primaryId: 'offer-1' })).toEqual({ boxId: null })
  })
})
