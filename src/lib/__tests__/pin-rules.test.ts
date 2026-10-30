import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  newDeviceToken,
  hashToken,
  LOCK_LIMIT,
  LOCK_WINDOW_MS,
  isLocked,
  CONFIRM_LIMIT,
  pairCode,
  pinDisplayName,
  pinFullName,
  pinEmail,
  deviceLabel,
} from '@/lib/pin/rules'

describe('device token', () => {
  it('hashes with sha256 hex', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
  it('makes 43-char tokens that differ each call', () => {
    const a = newDeviceToken()
    const b = newDeviceToken()
    expect(a).toHaveLength(43)
    expect(a).not.toBe(b)
  })
})

describe('isLocked', () => {
  const now = new Date('2026-10-30T12:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)
  it('exposes the limits', () => {
    expect(LOCK_LIMIT).toBe(5)
    expect(LOCK_WINDOW_MS).toBe(15 * 60_000)
  })
  it('locks at 5 failures inside the window', () => {
    expect(isLocked([1, 2, 3, 4, 5].map((m) => ago(m * 60_000)), now)).toBe(true)
  })
  it('does not lock at 4', () => {
    expect(isLocked([1, 2, 3, 4].map((m) => ago(m * 60_000)), now)).toBe(false)
  })
  it('ignores a failure older than the window', () => {
    expect(isLocked([1, 2, 3, 4, 16].map((m) => ago(m * 60_000)), now)).toBe(false)
  })
  it('takes its own limit (the confirm limit is 20)', () => {
    const nineteen = Array.from({ length: 19 }, (_, i) => ago((i + 1) * 30_000))
    expect(CONFIRM_LIMIT).toBe(20)
    expect(isLocked(nineteen, now, CONFIRM_LIMIT)).toBe(false)
    expect(isLocked([...nineteen, ago(10 * 60_000)], now, CONFIRM_LIMIT)).toBe(true)
  })
})

describe('pairCode', () => {
  const h1 = 'a'.repeat(64)
  const h2 = 'b'.repeat(64)
  it('is 4 uppercase hex characters', () => {
    expect(pairCode(h1)).toMatch(/^[0-9A-F]{4}$/)
  })
  it('is deterministic and differs between phones', () => {
    expect(pairCode(h1)).toBe(pairCode(h1))
    expect(pairCode(h1)).not.toBe(pairCode(h2))
  })
  it('is the first 4 hex of sha256("pair:" + hash), uppercased', () => {
    const want = createHash('sha256').update('pair:' + h1).digest('hex').slice(0, 4).toUpperCase()
    expect(pairCode(h1)).toBe(want)
  })
  it('does not leak a prefix of the hash itself', () => {
    expect(pairCode(h1)).not.toBe(h1.slice(0, 4).toUpperCase())
  })
})

describe('pinDisplayName', () => {
  it('uses first name + last initial', () => {
    expect(pinDisplayName({ name: 'Sam', lastName: 'Lee' })).toBe('Sam L.')
  })
  it('derives the initial from a full name when no last name', () => {
    expect(pinDisplayName({ name: 'Sam Lee', lastName: null })).toBe('Sam L.')
  })
  it('keeps a single name as is', () => {
    expect(pinDisplayName({ name: 'Raj', lastName: null })).toBe('Raj')
  })
})

describe('pinFullName', () => {
  it('joins first and last name', () => {
    expect(pinFullName({ name: 'Sam', lastName: 'Lee' })).toBe('Sam Lee')
  })
  it('does not double the surname when the name already has it', () => {
    expect(pinFullName({ name: 'Sam Lee', lastName: 'Lee' })).toBe('Sam Lee')
  })
  it('keeps a lone name as is, trimmed', () => {
    expect(pinFullName({ name: ' Raj ', lastName: null })).toBe('Raj')
    expect(pinFullName({ name: 'Raj', lastName: '  ' })).toBe('Raj')
  })
})

describe('pinEmail', () => {
  it('builds the synthetic login email', () => {
    expect(pinEmail('c1')).toBe('pin.c1@crew.controlaos.vercel.app')
  })
})

describe('deviceLabel', () => {
  it('reads an iPhone', () => {
    expect(
      deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'),
    ).toBe('iPhone')
  })
  it('reads an iPad', () => {
    expect(deviceLabel('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('iPad')
  })
  it('reads Android', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120')).toBe('Android phone')
  })
  it('falls back to Browser', () => {
    expect(deviceLabel(null)).toBe('Browser')
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('Browser')
  })
})
