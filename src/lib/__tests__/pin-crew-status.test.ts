import { describe, it, expect } from 'vitest'
import { crewStatus } from '@/lib/pin/crew-status'

describe('crewStatus', () => {
  it('no clock number → NO PIN red, even with devices', () => {
    expect(crewStatus({ clockId: null }, [])).toEqual({ label: 'NO PIN', tone: 'red', phones: 0 })
    expect(crewStatus({ clockId: null }, [{ status: 'APPROVED' }])).toEqual({ label: 'NO PIN', tone: 'red', phones: 1 })
  })

  it('a PIN but no devices → NOT YET grey', () => {
    expect(crewStatus({ clockId: '1234' }, [])).toEqual({ label: 'NOT YET', tone: 'grey', phones: 0 })
  })

  it('only rejected or revoked phones → NOT YET grey', () => {
    expect(crewStatus({ clockId: '1234' }, [{ status: 'REJECTED' }, { status: 'REVOKED' }])).toEqual({
      label: 'NOT YET', tone: 'grey', phones: 0,
    })
  })

  it('a pending phone → WAITING gold', () => {
    expect(crewStatus({ clockId: '1234' }, [{ status: 'PENDING' }])).toEqual({ label: 'WAITING', tone: 'gold', phones: 0 })
  })

  it('one approved phone → SET UP green', () => {
    expect(crewStatus({ clockId: '1234' }, [{ status: 'APPROVED' }, { status: 'REVOKED' }])).toEqual({
      label: 'SET UP', tone: 'green', phones: 1,
    })
  })

  it('pending plus approved → WAITING gold, and phones still counts the approved one', () => {
    expect(crewStatus({ clockId: '1234' }, [{ status: 'PENDING' }, { status: 'APPROVED' }])).toEqual({
      label: 'WAITING', tone: 'gold', phones: 1,
    })
  })

  it('counts every approved phone', () => {
    expect(crewStatus({ clockId: '1234' }, [{ status: 'APPROVED' }, { status: 'APPROVED' }]).phones).toBe(2)
  })
})
