import { describe, it, expect } from 'vitest'
import {
  DRAFT_VERSION,
  draftFromProposal,
  parseDraft,
  reconcileDraft,
  type GroupingDraft,
} from '@/lib/invoice-grouping-draft'
import type { GroupingProposal } from '@/lib/invoice-grouping'

const proposal: GroupingProposal = {
  groups: [
    { fileIds: ['a', 'b'], kind: 'photos', supplierName: 'Sysco', invoiceNumber: 'INV-1', invoiceDate: '2026-09-01' },
    { fileIds: ['c'], kind: 'pdf', supplierName: null, invoiceNumber: null, invoiceDate: null },
  ],
  unassigned: ['d'],
}

const ALL = ['a', 'b', 'c', 'd']

describe('draftFromProposal', () => {
  it('wraps the proposal with a version and an empty discard list', () => {
    const d = draftFromProposal(proposal)
    expect(d.v).toBe(DRAFT_VERSION)
    expect(d.groups).toEqual(proposal.groups)
    expect(d.unassigned).toEqual(['d'])
    expect(d.discarded).toEqual([])
  })

  it('copies arrays so later edits never alias the proposal', () => {
    const d = draftFromProposal(proposal)
    d.groups[0].fileIds.push('zzz')
    expect(proposal.groups[0].fileIds).toEqual(['a', 'b'])
  })
})

describe('parseDraft', () => {
  const good: GroupingDraft = {
    v: DRAFT_VERSION,
    groups: [
      { fileIds: ['a', 'b'], kind: 'photos', supplierName: 'Sysco', invoiceNumber: 'INV-1', invoiceDate: null },
      { fileIds: ['c'], kind: 'pdf', supplierName: null, invoiceNumber: null, invoiceDate: null },
    ],
    unassigned: [],
    discarded: ['d'],
  }

  it('accepts a well-formed draft', () => {
    const r = parseDraft(good, ALL)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.draft).toEqual(good)
  })

  it('rejects non-objects and wrong versions', () => {
    expect(parseDraft(null, ALL).ok).toBe(false)
    expect(parseDraft('nope', ALL).ok).toBe(false)
    expect(parseDraft({ ...good, v: 99 }, ALL).ok).toBe(false)
  })

  it('rejects an empty group', () => {
    const r = parseDraft({ ...good, groups: [...good.groups, { fileIds: [], kind: 'photos', supplierName: null, invoiceNumber: null, invoiceDate: null }] }, ALL)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/empty/i)
  })

  it('rejects an unknown kind and non-string metadata', () => {
    expect(parseDraft({ ...good, groups: [{ ...good.groups[0], kind: 'video' }] }, ALL).ok).toBe(false)
    expect(parseDraft({ ...good, groups: [{ ...good.groups[0], invoiceNumber: 42 }] }, ALL).ok).toBe(false)
  })

  it('rejects an id that does not belong to the session', () => {
    const r = parseDraft({ ...good, discarded: ['ghost'] }, ALL)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/ghost/)
  })

  it('rejects an id that appears twice, in any two buckets', () => {
    expect(parseDraft({ ...good, unassigned: ['a'] }, ALL).ok).toBe(false)
    expect(parseDraft({ ...good, discarded: ['d', 'd'] }, ALL).ok).toBe(false)
    expect(parseDraft({ ...good, groups: [good.groups[0], { ...good.groups[1], fileIds: ['c', 'b'] }] }, ALL).ok).toBe(false)
  })

  it('normalizes: trims metadata, empty strings become null, drops unknown keys', () => {
    const r = parseDraft({
      ...good,
      extra: 'ignored',
      groups: [{ ...good.groups[0], supplierName: '  Sysco ', invoiceNumber: '   ', invoiceDate: '', junk: 1 }, good.groups[1]],
    }, ALL)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.draft.groups[0]).toEqual({ fileIds: ['a', 'b'], kind: 'photos', supplierName: 'Sysco', invoiceNumber: null, invoiceDate: null })
      expect('extra' in r.draft).toBe(false)
    }
  })
})

describe('reconcileDraft', () => {
  const d: GroupingDraft = {
    v: DRAFT_VERSION,
    groups: [
      { fileIds: ['a', 'b'], kind: 'photos', supplierName: 'Sysco', invoiceNumber: 'INV-1', invoiceDate: null },
      { fileIds: ['c'], kind: 'pdf', supplierName: null, invoiceNumber: null, invoiceDate: null },
    ],
    unassigned: ['e'],
    discarded: ['d'],
  }

  it('returns an equal draft when nothing changed', () => {
    expect(reconcileDraft(d, ['a', 'b', 'c', 'd', 'e'])).toEqual(d)
  })

  it('drops ids the session no longer has and collapses groups left empty', () => {
    const r = reconcileDraft(d, ['a', 'b', 'd', 'e'])   // 'c' (the pdf) is gone
    expect(r.groups).toEqual([d.groups[0]])
    expect(r.discarded).toEqual(['d'])
  })

  it('surfaces files the draft never mentions as unassigned, in session order', () => {
    const r = reconcileDraft(d, ['a', 'b', 'c', 'd', 'e', 'x', 'y'])
    expect(r.unassigned).toEqual(['e', 'x', 'y'])
  })

  it('keeps a discarded id discarded even when it is still in the session', () => {
    const r = reconcileDraft(d, ['a', 'b', 'c', 'd', 'e'])
    expect(r.discarded).toEqual(['d'])
    expect(r.unassigned).not.toContain('d')
  })

  it('does not mutate its input', () => {
    const before = JSON.stringify(d)
    reconcileDraft(d, ['a'])
    expect(JSON.stringify(d)).toBe(before)
  })
})
