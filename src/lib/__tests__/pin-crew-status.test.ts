import { describe, it, expect } from 'vitest'
import { crewStatus, pinBlocked } from '@/lib/pin/crew-status'

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

  it('a manager (email login) → EMAIL LOGIN grey, even with a PIN and a pending phone', () => {
    expect(crewStatus({ clockId: '1234' }, [{ status: 'PENDING' }], 'MANAGER')).toEqual({
      label: 'EMAIL LOGIN', tone: 'grey', phones: 0,
    })
  })

  it('a switched-off login → SWITCHED OFF red, even with an approved phone', () => {
    expect(crewStatus({ clockId: '1234' }, [{ status: 'APPROVED' }], 'SWITCHED_OFF')).toEqual({
      label: 'SWITCHED OFF', tone: 'red', phones: 1,
    })
  })

  it('blocked wins over NO PIN; null blocked changes nothing', () => {
    expect(crewStatus({ clockId: null }, [], 'MANAGER').label).toBe('EMAIL LOGIN')
    expect(crewStatus({ clockId: null }, [], null).label).toBe('NO PIN')
  })
})

describe('pinBlocked', () => {
  const PIN = 'pin.c1@crew.controlaos.vercel.app'
  it('no login yet → not blocked', () => {
    expect(pinBlocked('c1', null)).toBeNull()
  })
  it("the cook's own PIN login → not blocked", () => {
    expect(pinBlocked('c1', { role: 'LEAD', isActive: true, email: PIN })).toBeNull()
  })
  it('a manager → MANAGER, even on a PIN login', () => {
    expect(pinBlocked('c1', { role: 'MANAGER', isActive: true, email: PIN })).toBe('MANAGER')
  })
  it('switched off → SWITCHED_OFF', () => {
    expect(pinBlocked('c1', { role: 'STAFF', isActive: false, email: 'robyn@gmail.com' })).toBe('SWITCHED_OFF')
  })
  it('an email login, or another cook’s PIN login → EMAIL_LOGIN, shown as EMAIL LOGIN grey', () => {
    expect(pinBlocked('c1', { role: 'STAFF', isActive: true, email: 'robyn@gmail.com' })).toBe('EMAIL_LOGIN')
    expect(pinBlocked('c1', { role: 'STAFF', isActive: true, email: 'pin.c2@crew.controlaos.vercel.app' })).toBe('EMAIL_LOGIN')
    expect(crewStatus({ clockId: '1234' }, [{ status: 'PENDING' }], 'EMAIL_LOGIN')).toEqual({
      label: 'EMAIL LOGIN', tone: 'grey', phones: 0,
    })
  })
})
