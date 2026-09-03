// The bulk-upload sorter's persisted state: the proposed grouping PLUS every
// edit the user has made (moves, discards, corrected numbers). Stored on
// InvoiceSession.groupingDraft while the session is GROUPING, so closing the
// sorter, locking the phone, or opening it on another device never loses work.
// Pure — no DB, no API. Design: docs/superpowers/specs/2026-09-03-invoice-batch-grouping-redesign-design.md
import type { GroupingProposal, ProposedGroup, GroupKind } from './invoice-grouping'

export const DRAFT_VERSION = 1 as const

export interface GroupingDraft {
  v: typeof DRAFT_VERSION
  groups: ProposedGroup[]
  /** Files the user still has to place. Confirm is blocked while non-empty. */
  unassigned: string[]
  /** Files to delete at confirm (double-shots, blurry retakes). Restorable until then. */
  discarded: string[]
}

export type ParseResult = { ok: true; draft: GroupingDraft } | { ok: false; error: string }

const KINDS: ReadonlySet<string> = new Set<GroupKind>(['photos', 'pdf', 'csv'])

export function draftFromProposal(p: GroupingProposal): GroupingDraft {
  return {
    v: DRAFT_VERSION,
    groups: p.groups.map(g => ({ ...g, fileIds: [...g.fileIds] })),
    unassigned: [...p.unassigned],
    discarded: [],
  }
}

// A metadata field: string|null; trimmed; empty ⇒ null; anything else invalid.
function metaField(v: unknown, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v == null) return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false, error: `${label} must be a string or null` }
  const t = v.trim()
  return { ok: true, value: t.length ? t : null }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

/**
 * Validate an untrusted draft (request body or a stored JSON column) against
 * the session's file ids. Shape errors, unknown ids and duplicated ids are all
 * rejected — a draft that assigns one photo to two invoices must never be
 * stored, because /split would then have to guess. Completeness is NOT
 * required here (see reconcileDraft).
 */
export function parseDraft(raw: unknown, sessionFileIds: readonly string[]): ParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'draft must be an object' }
  const r = raw as Record<string, unknown>
  if (r.v !== DRAFT_VERSION) return { ok: false, error: `unsupported draft version ${String(r.v)}` }
  if (!Array.isArray(r.groups)) return { ok: false, error: 'groups must be an array' }
  if (!isStringArray(r.unassigned)) return { ok: false, error: 'unassigned must be an array of file ids' }
  if (!isStringArray(r.discarded)) return { ok: false, error: 'discarded must be an array of file ids' }

  const known = new Set(sessionFileIds)
  const seen = new Set<string>()
  const claim = (id: string, where: string): string | null => {
    if (!known.has(id)) return `unknown file ${id} in ${where}`
    if (seen.has(id)) return `file ${id} appears twice (${where})`
    seen.add(id)
    return null
  }

  const groups: ProposedGroup[] = []
  for (const [i, g] of r.groups.entries()) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return { ok: false, error: `group ${i + 1} must be an object` }
    const go = g as Record<string, unknown>
    if (!isStringArray(go.fileIds)) return { ok: false, error: `group ${i + 1}: fileIds must be an array of file ids` }
    if (go.fileIds.length === 0) return { ok: false, error: `group ${i + 1} is empty` }
    if (typeof go.kind !== 'string' || !KINDS.has(go.kind)) return { ok: false, error: `group ${i + 1}: unknown kind ${String(go.kind)}` }
    for (const id of go.fileIds) {
      const err = claim(id, `group ${i + 1}`)
      if (err) return { ok: false, error: err }
    }
    const sup = metaField(go.supplierName, `group ${i + 1}: supplierName`)
    if (!sup.ok) return sup
    const num = metaField(go.invoiceNumber, `group ${i + 1}: invoiceNumber`)
    if (!num.ok) return num
    const date = metaField(go.invoiceDate, `group ${i + 1}: invoiceDate`)
    if (!date.ok) return date
    groups.push({
      fileIds: [...go.fileIds],
      kind: go.kind as GroupKind,
      supplierName: sup.value,
      invoiceNumber: num.value,
      invoiceDate: date.value,
    })
  }
  for (const id of r.unassigned) {
    const err = claim(id, 'unassigned')
    if (err) return { ok: false, error: err }
  }
  for (const id of r.discarded) {
    const err = claim(id, 'discarded')
    if (err) return { ok: false, error: err }
  }

  return { ok: true, draft: { v: DRAFT_VERSION, groups, unassigned: [...r.unassigned], discarded: [...r.discarded] } }
}

/**
 * Bring a (valid) draft in line with the session's CURRENT files: ids the
 * session no longer has are dropped (groups left empty collapse), files the
 * draft never mentions surface as unassigned in session order. Discards stay
 * discarded. Never mutates its input.
 */
export function reconcileDraft(draft: GroupingDraft, sessionFileIds: readonly string[]): GroupingDraft {
  const known = new Set(sessionFileIds)
  const groups = draft.groups
    .map(g => ({ ...g, fileIds: g.fileIds.filter(id => known.has(id)) }))
    .filter(g => g.fileIds.length > 0)
  const discarded = draft.discarded.filter(id => known.has(id))
  const mentioned = new Set<string>([
    ...groups.flatMap(g => g.fileIds),
    ...draft.unassigned,
    ...discarded,
  ])
  const unassigned = [
    ...draft.unassigned.filter(id => known.has(id)),
    ...sessionFileIds.filter(id => !mentioned.has(id)),
  ]
  return { v: DRAFT_VERSION, groups, unassigned, discarded }
}

// ── Sorter operations ──────────────────────────────────────────────────────
// Every edit the sorter can make, as a pure function on the draft. The modal
// holds ONE draft object and pipes it through these; the result is what gets
// PUT to the session. All of them return new objects and never mutate input.

export type FileKindOf = (id: string) => 'photo' | 'pdf' | 'csv'
export type MoveTarget = { group: number } | 'new'
export type MoveResult = { ok: true; draft: GroupingDraft } | { ok: false; error: string }

const OWN_INVOICE = 'A PDF or spreadsheet is always its own invoice — it can\'t share one with photos'

function groupKindFor(k: 'photo' | 'pdf' | 'csv'): GroupKind {
  return k === 'photo' ? 'photos' : k
}

/** Every id in the draft, in display order: groups (in page order), unassigned, discarded. */
function orderedIds(draft: GroupingDraft): string[] {
  return [...draft.groups.flatMap(g => g.fileIds), ...draft.unassigned, ...draft.discarded]
}

/** Remove ids from every bucket; groups left empty collapse. */
function strip(draft: GroupingDraft, ids: ReadonlySet<string>): GroupingDraft {
  return {
    v: DRAFT_VERSION,
    groups: draft.groups
      .map(g => ({ ...g, fileIds: g.fileIds.filter(id => !ids.has(id)) }))
      .filter(g => g.fileIds.length > 0),
    unassigned: draft.unassigned.filter(id => !ids.has(id)),
    discarded: draft.discarded.filter(id => !ids.has(id)),
  }
}

const emptyGroup = (kind: GroupKind, fileIds: string[]): ProposedGroup =>
  ({ fileIds, kind, supplierName: null, invoiceNumber: null, invoiceDate: null })

/**
 * Move a selection into an existing invoice or a new one. Photos may join any
 * photo invoice; a PDF/CSV is always alone in its own group (kind pdf/csv), so
 * "new" gives each of them its own group and an existing photo group refuses
 * them. Moved files are appended in their current draft order, not selection
 * order. A PDF/CSV already alone in its own group is left untouched by "new".
 */
export function moveFiles(draft: GroupingDraft, fileIds: readonly string[], target: MoveTarget, kindOf: FileKindOf): MoveResult {
  if (fileIds.length === 0) return { ok: false, error: 'Nothing selected' }
  const sel = new Set(fileIds)
  const ordered = orderedIds(draft).filter(id => sel.has(id))
  if (ordered.length !== sel.size) return { ok: false, error: 'Selection includes a file that is not in this batch' }

  if (target !== 'new') {
    const tg = draft.groups[target.group]
    if (!tg) return { ok: false, error: 'That invoice no longer exists' }
    if (tg.kind !== 'photos') return { ok: false, error: OWN_INVOICE }
    if (ordered.some(id => kindOf(id) !== 'photo')) return { ok: false, error: OWN_INVOICE }
    // Filter every bucket but keep the target's index stable until the
    // append, THEN collapse — the target can never end up empty.
    const groups = draft.groups.map(g => ({ ...g, fileIds: g.fileIds.filter(id => !sel.has(id)) }))
    groups[target.group] = { ...groups[target.group], fileIds: [...groups[target.group].fileIds, ...ordered] }
    return {
      ok: true,
      draft: {
        v: DRAFT_VERSION,
        groups: groups.filter(g => g.fileIds.length > 0),
        unassigned: draft.unassigned.filter(id => !sel.has(id)),
        discarded: draft.discarded.filter(id => !sel.has(id)),
      },
    }
  }

  const aloneAlready = (id: string) =>
    kindOf(id) !== 'photo' && draft.groups.some(g => g.fileIds.length === 1 && g.fileIds[0] === id)
  const moving = ordered.filter(id => !aloneAlready(id))
  if (moving.length === 0) return { ok: true, draft: strip(draft, new Set()) }
  const next = strip(draft, new Set(moving))
  const photos = moving.filter(id => kindOf(id) === 'photo')
  if (photos.length > 0) next.groups.push(emptyGroup('photos', photos))
  for (const id of moving) {
    const k = kindOf(id)
    if (k !== 'photo') next.groups.push(emptyGroup(groupKindFor(k), [id]))
  }
  return { ok: true, draft: next }
}

/** Nudge a page one step earlier (-1) or later (+1) within its invoice. Clamped; no-op outside a group. */
export function reorderInGroup(draft: GroupingDraft, fileId: string, direction: -1 | 1): GroupingDraft {
  const gi = draft.groups.findIndex(g => g.fileIds.includes(fileId))
  if (gi < 0) return strip(draft, new Set())
  const ids = [...draft.groups[gi].fileIds]
  const i = ids.indexOf(fileId)
  const j = i + direction
  if (j < 0 || j >= ids.length) return strip(draft, new Set())
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  const groups = draft.groups.map((g, k) => (k === gi ? { ...g, fileIds: ids } : { ...g, fileIds: [...g.fileIds] }))
  return { v: DRAFT_VERSION, groups, unassigned: [...draft.unassigned], discarded: [...draft.discarded] }
}

/** Throw files out (double-shots, blurry retakes). Queued for deletion at confirm; restorable until then. */
export function discardFiles(draft: GroupingDraft, fileIds: readonly string[]): GroupingDraft {
  const known = new Set(orderedIds(draft))
  const adding = fileIds.filter((id, i) => known.has(id) && !draft.discarded.includes(id) && fileIds.indexOf(id) === i)
  const next = strip(draft, new Set(adding))
  next.discarded = [...next.discarded, ...adding]
  return next
}

/** Restore lands in "unassigned" so the user must place the page deliberately. */
export function restoreFiles(draft: GroupingDraft, fileIds: readonly string[]): GroupingDraft {
  const restoring = fileIds.filter((id, i) => draft.discarded.includes(id) && fileIds.indexOf(id) === i)
  const next = strip(draft, new Set(restoring))
  next.unassigned = [...next.unassigned, ...restoring]
  return next
}

/** Patch one invoice's header fields. Trimmed; empty ⇒ null. */
export function setGroupMeta(
  draft: GroupingDraft,
  groupIdx: number,
  patch: Partial<Pick<ProposedGroup, 'supplierName' | 'invoiceNumber' | 'invoiceDate'>>,
): GroupingDraft {
  const norm = (v: string | null | undefined): string | null => {
    const t = (v ?? '').trim()
    return t.length ? t : null
  }
  const groups = draft.groups.map((g, i) => {
    const copy = { ...g, fileIds: [...g.fileIds] }
    if (i !== groupIdx) return copy
    if ('supplierName' in patch) copy.supplierName = norm(patch.supplierName)
    if ('invoiceNumber' in patch) copy.invoiceNumber = norm(patch.invoiceNumber)
    if ('invoiceDate' in patch) copy.invoiceDate = norm(patch.invoiceDate)
    return copy
  })
  return { v: DRAFT_VERSION, groups, unassigned: [...draft.unassigned], discarded: [...draft.discarded] }
}
