import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async (_min?: string) => ({ id: 'u1', name: null, email: 'sam@x.ca', role: 'STAFF', isActive: true }))
const assertRcWritable = vi.fn(async () => {})
const runFindUnique = vi.fn()
const runUpdate = vi.fn(async (_a: unknown) => ({ count: 1 }))
const loadRunView = vi.fn(async () => ({ id: 'r1', status: 'SIGNED' }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistRun: {
      findUnique: (...a: unknown[]) => runFindUnique(...a),
      updateMany: (...a: unknown[]) => runUpdate(...a),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  assertRcWritable: (...a: unknown[]) => assertRcWritable(...(a as [])),
}))
vi.mock('@/lib/checklists/runs', () => ({
  loadRunView: (...a: unknown[]) => loadRunView(...(a as [])),
}))

const { POST } = await import('@/app/api/checklists/runs/[id]/signoff/route')
const { POST: REOPEN } = await import('@/app/api/checklists/runs/[id]/reopen/route')

const req = (body: unknown = {}) => ({ json: async () => body }) as unknown as NextRequest
const sign = (body?: unknown) => POST(req(body), { params: { id: 'r1' } })
const L = (status: string, isBlocker = true) => ({ status, isBlocker })

const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1', phase: 'OPEN', status: 'OPEN',
  station: { revenueCenterId: 'rc1', isShared: false },
  lines: [L('DONE'), L('DONE', false)],
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  runUpdate.mockResolvedValue({ count: 1 })
  runFindUnique.mockResolvedValue(run())
})

describe('POST /api/checklists/runs/[id]/signoff', () => {
  it('signs off and uses the email when the user has no name', async () => {
    const res = await sign()
    expect(res.status).toBe(200)
    expect((await res.json()).run.status).toBe('SIGNED')
    const data = runUpdate.mock.calls[0][0].data
    expect(data).toMatchObject({ status: 'SIGNED', signedOffById: 'u1', signedOffByName: 'sam@x.ca' })
    expect(data.signedOffAt).toBeInstanceOf(Date)
    expect(data).not.toHaveProperty('handoverNote')
  })

  it('409 "1 before-doors job left" with one blocker TODO on OPEN', async () => {
    runFindUnique.mockResolvedValue(run({ lines: [L('TODO'), L('DONE')] }))
    const res = await sign()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('1 before-doors job left')
    expect(runUpdate).not.toHaveBeenCalled()
  })

  it('pluralises, and words CLOSE differently', async () => {
    runFindUnique.mockResolvedValue(run({ lines: [L('TODO'), L('TODO')] }))
    expect((await (await sign()).json()).error).toBe('2 before-doors jobs left')
    runFindUnique.mockResolvedValue(run({ phase: 'CLOSE', lines: [L('TODO')] }))
    expect((await (await sign()).json()).error).toBe('1 job left before you leave')
    runFindUnique.mockResolvedValue(run({ phase: 'CLOSE', lines: [L('TODO'), L('TODO')] }))
    expect((await (await sign()).json()).error).toBe('2 jobs left before you leave')
  })

  it('a FLAGGED blocker counts as handled', async () => {
    runFindUnique.mockResolvedValue(run({ lines: [L('FLAGGED'), L('TODO', false)] }))
    const res = await sign()
    expect(res.status).toBe(200)
    expect(runUpdate.mock.calls[0][0].data.status).toBe('SIGNED')
  })

  it('409 on the shared whole-kitchen station', async () => {
    runFindUnique.mockResolvedValue(run({ station: { revenueCenterId: 'rc1', isShared: true } }))
    const res = await sign()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('The whole-kitchen list has no sign-off')
    expect(runUpdate).not.toHaveBeenCalled()
  })

  it('writes only while the run is still OPEN, and 409s when someone else signed first', async () => {
    runUpdate.mockResolvedValueOnce({ count: 0 })
    const res = await sign()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Already signed off')
    expect(runUpdate.mock.calls[0][0].where).toEqual({ id: 'r1', status: 'OPEN' })
    expect(loadRunView).not.toHaveBeenCalled()
  })

  it('409 when already signed, and when there are no lines', async () => {
    runFindUnique.mockResolvedValue(run({ status: 'SIGNED' }))
    expect((await (await sign()).json()).error).toBe('Already signed off')
    runFindUnique.mockResolvedValue(run({ lines: [] }))
    const res = await sign()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Nothing to sign off')
  })

  it('404 when the run is missing; 403 when out of scope', async () => {
    runFindUnique.mockResolvedValue(null)
    expect((await sign()).status).toBe(404)
    runFindUnique.mockResolvedValue(run())
    assertRcWritable.mockRejectedValueOnce(new MockAuthError(403, 'no'))
    expect((await sign()).status).toBe(403)
    expect(runUpdate).not.toHaveBeenCalled()
  })

  it('CLOSE keeps a trimmed handover note; empty becomes null; OPEN ignores it', async () => {
    runFindUnique.mockResolvedValue(run({ phase: 'CLOSE' }))
    await sign({ handoverNote: '  fryer oil low  ' })
    expect(runUpdate.mock.calls[0][0].data.handoverNote).toBe('fryer oil low')
    await sign({ handoverNote: '   ' })
    expect(runUpdate.mock.calls[1][0].data.handoverNote).toBeNull()
    runFindUnique.mockResolvedValue(run())
    await sign({ handoverNote: 'ignored' })
    expect(runUpdate.mock.calls[2][0].data).not.toHaveProperty('handoverNote')
  })

  it('400 for a handover note over 1000 characters', async () => {
    runFindUnique.mockResolvedValue(run({ phase: 'CLOSE' }))
    const res = await sign({ handoverNote: 'x'.repeat(1001) })
    expect(res.status).toBe(400)
    expect(runUpdate).not.toHaveBeenCalled()
  })
})

describe('POST /api/checklists/runs/[id]/reopen', () => {
  const reopen = () => REOPEN(req(), { params: { id: 'r1' } })

  it('needs LEAD, reopens, clears the signer and keeps the note', async () => {
    runFindUnique.mockResolvedValue(run({ status: 'SIGNED' }))
    const res = await reopen()
    expect(res.status).toBe(200)
    expect(requireSession).toHaveBeenCalledWith('LEAD')
    const data = runUpdate.mock.calls[0][0].data
    expect(data).toEqual({ status: 'OPEN', signedOffById: null, signedOffByName: null, signedOffAt: null })
  })

  it('409 when the run is not signed', async () => {
    const res = await reopen()
    expect(res.status).toBe(409)
    expect(runUpdate).not.toHaveBeenCalled()
  })

  it('writes only while the run is still SIGNED, and 409s when it was reopened first', async () => {
    runFindUnique.mockResolvedValue(run({ status: 'SIGNED' }))
    runUpdate.mockResolvedValueOnce({ count: 0 })
    const res = await reopen()
    expect(res.status).toBe(409)
    expect(runUpdate.mock.calls[0][0].where).toEqual({ id: 'r1', status: 'SIGNED' })
  })

  it('403 below LEAD', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(403, 'Insufficient permissions'))
    expect((await reopen()).status).toBe(403)
  })
})
