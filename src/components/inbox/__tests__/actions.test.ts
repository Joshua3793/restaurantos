import { describe, it, expect, vi } from 'vitest'
import { sendInboxAction, type Result } from '../api'
import type { InboxAction } from '../format'

type Item = { id: string; status: string }
const ok = (status = 'OPEN'): Result<{ item: Item }> => ({ ok: true, data: { item: { id: 'i1', status } } })
const fail: Result<{ item: Item }> = { ok: false, status: 409, error: 'Someone else changed it.' }

function setup(responses: Result<{ item: Item }>[]) {
  const sent: InboxAction[] = []
  const send = vi.fn(async (a: InboxAction) => { sent.push(a); return responses.shift()! })
  const refreshCount = vi.fn(async () => {})
  return { sent, send, refreshCount }
}

describe('sendInboxAction — the shared bell count follows an action on /inbox', () => {
  const kinds: InboxAction[] = [
    { kind: 'done' }, { kind: 'snooze' }, { kind: 'wait' }, { kind: 'reopen' },
    { kind: 'retag', tagId: 'tag-stock' }, { kind: 'note', note: 'Called the fryer guy' },
  ]
  for (const action of kinds) {
    it(`${action.kind}: refreshes the count for this kitchen once it is saved`, async () => {
      const { send, refreshCount } = setup([ok()])
      const { r } = await sendInboxAction({ action, note: '', send, rcId: 'rcA', refreshCount })
      expect(r.ok).toBe(true)
      expect(refreshCount).toHaveBeenCalledWith('rcA')
    })
  }

  it('a failed action changes nothing, so the count is left alone', async () => {
    const { send, refreshCount } = setup([fail])
    const { r } = await sendInboxAction({ action: { kind: 'done' }, note: '', send, rcId: 'rcA', refreshCount })
    expect(r.ok).toBe(false)
    expect(refreshCount).not.toHaveBeenCalled()
  })

  it('snooze with a note saves the note first; refreshes even if the snooze then fails', async () => {
    const { sent, send, refreshCount } = setup([ok(), fail])
    const { r, noteSaved } = await sendInboxAction({ action: { kind: 'snooze' }, note: 'fridge guy at 2', send, rcId: 'rcA', refreshCount })
    expect(sent).toEqual([{ kind: 'note', note: 'fridge guy at 2' }, { kind: 'snooze' }])
    expect(r.ok).toBe(false)
    expect(noteSaved).toBe(true)
    expect(refreshCount).toHaveBeenCalledWith('rcA')
  })

  it('Mark fixed carries the typed note in one request', async () => {
    const { sent, send, refreshCount } = setup([ok('DONE')])
    const { noteSaved } = await sendInboxAction({ action: { kind: 'done' }, note: 'new gasket', send, rcId: 'rcA', refreshCount })
    expect(sent).toEqual([{ kind: 'done', note: 'new gasket' }])
    expect(noteSaved).toBe(true)
  })

  it('no kitchen picked: nothing to refresh, and a refresh failure never breaks the action', async () => {
    const a = setup([ok()])
    await sendInboxAction({ action: { kind: 'done' }, note: '', send: a.send, rcId: null, refreshCount: a.refreshCount })
    expect(a.refreshCount).not.toHaveBeenCalled()
    const b = setup([ok()])
    b.refreshCount.mockRejectedValueOnce(new Error('offline'))
    const { r } = await sendInboxAction({ action: { kind: 'done' }, note: '', send: b.send, rcId: 'rcA', refreshCount: b.refreshCount })
    expect(r.ok).toBe(true)
  })
})
