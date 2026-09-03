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
