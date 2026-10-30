import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Only accepting an invite switches a login on. A "Forgot password" link must
// never undo a manager's switch-off.

const verifyOtp = vi.fn()
const exchangeCodeForSession = vi.fn()
const getUser = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { verifyOtp, exchangeCodeForSession, getUser } }),
}))

const userUpdate = vi.fn()
vi.mock('@/lib/prisma', () => ({ prisma: { user: { update: (...a: unknown[]) => userUpdate(...a) } } }))

const updateUserById = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ auth: { admin: { updateUserById } } }) }))

const { GET } = await import('@/app/auth/callback/route')

const call = (query: string) => GET(new NextRequest(`https://app.test/auth/callback?${query}`))

beforeEach(() => {
  vi.clearAllMocks()
  verifyOtp.mockResolvedValue({ error: null })
  exchangeCodeForSession.mockResolvedValue({ error: null })
  getUser.mockResolvedValue({ data: { user: { id: 'u1', app_metadata: { role: 'STAFF', isActive: false } } } })
  userUpdate.mockResolvedValue({ role: 'LEAD', isActive: true })
  updateUserById.mockResolvedValue({ data: {}, error: null })
})

describe('/auth/callback', () => {
  it('accepting an invite switches the login on in both stores, page gate written from the row', async () => {
    const res = await call('token_hash=h&type=invite')
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'u1' }, data: { isActive: true }, select: { role: true, isActive: true },
    })
    expect(updateUserById).toHaveBeenCalledWith('u1', {
      app_metadata: { role: 'LEAD', isActive: true },
      user_metadata: { isActive: true },
    })
    expect(res.headers.get('location')).toBe('https://app.test/auth/set-password')
  })

  it('a password-recovery link (token hash) leaves a switched-off login off', async () => {
    const res = await call('token_hash=h&type=recovery')
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'recovery' })
    expect(userUpdate).not.toHaveBeenCalled()
    expect(updateUserById).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toBe('https://app.test/auth/set-password')
  })

  it('a password-recovery link (browser code flow) leaves a switched-off login off', async () => {
    const res = await call('code=abc&next=/auth/set-password')
    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc')
    expect(userUpdate).not.toHaveBeenCalled()
    expect(updateUserById).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toBe('https://app.test/auth/set-password')
  })

  it('an invite with no app user row switches nothing on', async () => {
    userUpdate.mockRejectedValue(new Error('Record to update not found'))
    await call('token_hash=h&type=invite')
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('logs (and still lands on set-password) when the page-gate write fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    updateUserById.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await call('token_hash=h&type=invite')
    expect(err).toHaveBeenCalled()
    expect(res.headers.get('location')).toBe('https://app.test/auth/set-password')
    err.mockRestore()
  })

  it('a bad link goes back to login and touches nothing', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'expired' } })
    const res = await call('token_hash=h&type=invite')
    expect(res.headers.get('location')).toBe('https://app.test/login?error=invalid_link')
    expect(userUpdate).not.toHaveBeenCalled()
  })
})
