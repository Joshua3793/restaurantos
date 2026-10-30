import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
const cookFindUnique = vi.fn()
vi.mock('@/lib/prisma', () => ({
  prisma: { cook: { findUnique: (...a: unknown[]) => cookFindUnique(...a) } },
}))

const { displayName, whoOf } = await import('@/lib/checklists/who')

const user = (over: Partial<{ name: string | null; email: string }> = {}) => ({
  id: 'u1', name: null as string | null, email: 'joshua37ca@gmail.com', ...over,
})

beforeEach(() => {
  cookFindUnique.mockReset()
  cookFindUnique.mockResolvedValue(null)
})

describe('displayName', () => {
  it('prefers the linked active cook’s name', async () => {
    cookFindUnique.mockResolvedValue({ name: 'Joshua Fergie', isActive: true })
    expect(await displayName(user({ name: 'Login Name' }))).toBe('Joshua Fergie')
    expect(cookFindUnique).toHaveBeenCalledWith({ where: { userId: 'u1' }, select: { name: true, isActive: true } })
  })
  it('falls back to the user’s name when the cook is inactive or missing', async () => {
    cookFindUnique.mockResolvedValue({ name: 'Old Cook', isActive: false })
    expect(await displayName(user({ name: 'Sam Lee' }))).toBe('Sam Lee')
    cookFindUnique.mockResolvedValue(null)
    expect(await displayName(user({ name: 'Sam Lee' }))).toBe('Sam Lee')
  })
  it('falls back to the email’s local part, never the full email', async () => {
    expect(await displayName(user())).toBe('joshua37ca')
  })
  it('whoOf pairs the id with the display name', async () => {
    expect(await whoOf(user())).toEqual({ id: 'u1', name: 'joshua37ca' })
  })
})
