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

// ── Sorter operations (step 4) ─────────────────────────────────────────────

import {
  moveFiles,
  reorderInGroup,
  discardFiles,
  restoreFiles,
  setGroupMeta,
} from '@/lib/invoice-grouping-draft'

const kindOf = (id: string): 'photo' | 'pdf' | 'csv' =>
  id.startsWith('pdf') ? 'pdf' : id.startsWith('csv') ? 'csv' : 'photo'

function base(): GroupingDraft {
  return {
    v: DRAFT_VERSION,
    groups: [
      { fileIds: ['a', 'b', 'c'], kind: 'photos', supplierName: 'Sysco', invoiceNumber: 'INV-1', invoiceDate: null },
      { fileIds: ['d'], kind: 'photos', supplierName: 'GFS', invoiceNumber: null, invoiceDate: null },
      { fileIds: ['pdf1'], kind: 'pdf', supplierName: 'Snow Cap', invoiceNumber: '55', invoiceDate: null },
    ],
    unassigned: ['e'],
    discarded: ['f'],
  }
}

describe('moveFiles', () => {
  it('moves photos into an existing photo group, appended in draft order, and collapses emptied groups', () => {
    const r = moveFiles(base(), ['d', 'b'], { group: 0 }, kindOf)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.groups[0].fileIds).toEqual(['a', 'c', 'b', 'd'])
    expect(r.draft.groups.map(g => g.kind)).toEqual(['photos', 'pdf'])
  })

  it('moves an unassigned or discarded photo into a group', () => {
    const r = moveFiles(base(), ['e', 'f'], { group: 1 }, kindOf)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.groups[1].fileIds).toEqual(['d', 'e', 'f'])
    expect(r.draft.unassigned).toEqual([])
    expect(r.draft.discarded).toEqual([])
  })

  it('"new" puts all selected photos in ONE new group and each pdf/csv in its own', () => {
    const d = base()
    d.unassigned.push('csv1')
    const r = moveFiles(d, ['b', 'c', 'pdf1', 'csv1'], 'new', kindOf)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // pdf1 was already alone in its own group → left exactly where it was.
    expect(r.draft.groups.map(g => [g.kind, g.fileIds])).toEqual([
      ['photos', ['a']],
      ['photos', ['d']],
      ['pdf', ['pdf1']],
      ['photos', ['b', 'c']],
      ['csv', ['csv1']],
    ])
    expect(r.draft.groups[2].supplierName).toBe('Snow Cap')
  })

  it('a pdf that is already alone in its own group is a no-op for "new" (keeps its metadata)', () => {
    const r = moveFiles(base(), ['pdf1'], 'new', kindOf)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft).toEqual(base())
  })

  it('refuses to merge a pdf or csv into a photo group', () => {
    const r = moveFiles(base(), ['pdf1'], { group: 0 }, kindOf)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/own invoice/i)
  })

  it('refuses to move a photo into a pdf group', () => {
    const r = moveFiles(base(), ['a'], { group: 2 }, kindOf)
    expect(r.ok).toBe(false)
  })

  it('rejects an unknown target index and an empty selection', () => {
    expect(moveFiles(base(), ['a'], { group: 9 }, kindOf).ok).toBe(false)
    expect(moveFiles(base(), [], { group: 0 }, kindOf).ok).toBe(false)
  })

  it('moving every file of a group into a later group keeps target index stable', () => {
    // group 0 empties → collapses; the target was group 1, which is now group 0.
    const r = moveFiles(base(), ['a', 'b', 'c'], { group: 1 }, kindOf)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.groups[0]).toMatchObject({ supplierName: 'GFS', fileIds: ['d', 'a', 'b', 'c'] })
  })
})

describe('reorderInGroup', () => {
  it('moves a page earlier / later within its group and clamps at the ends', () => {
    const d = base()
    expect(reorderInGroup(d, 'b', -1).groups[0].fileIds).toEqual(['b', 'a', 'c'])
    expect(reorderInGroup(d, 'b', +1).groups[0].fileIds).toEqual(['a', 'c', 'b'])
    expect(reorderInGroup(d, 'a', -1).groups[0].fileIds).toEqual(['a', 'b', 'c'])
    expect(reorderInGroup(d, 'c', +1).groups[0].fileIds).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op for files not in a group', () => {
    expect(reorderInGroup(base(), 'e', -1)).toEqual(base())
  })
})

describe('discardFiles / restoreFiles', () => {
  it('discard takes files from groups and unassigned, collapsing emptied groups', () => {
    const r = discardFiles(base(), ['d', 'e', 'a'])
    expect(r.groups.map(g => g.fileIds)).toEqual([['b', 'c'], ['pdf1']])
    expect(r.unassigned).toEqual([])
    expect(r.discarded).toEqual(['f', 'd', 'e', 'a'])
  })

  it('restore lands in unassigned so the user must place it deliberately', () => {
    const r = restoreFiles(base(), ['f'])
    expect(r.discarded).toEqual([])
    expect(r.unassigned).toEqual(['e', 'f'])
  })
})

describe('setGroupMeta', () => {
  it('patches one group, trimming and nulling empty strings', () => {
    const r = setGroupMeta(base(), 1, { supplierName: '  Gordon Food Service ', invoiceNumber: '' })
    expect(r.groups[1]).toMatchObject({ supplierName: 'Gordon Food Service', invoiceNumber: null })
    expect(r.groups[0]).toEqual(base().groups[0])
  })
})
