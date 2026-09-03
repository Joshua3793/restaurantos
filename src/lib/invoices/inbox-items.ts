import type { SessionSummary, SessionStatus } from '@/components/invoices/types'

export interface Signal {
  id: string
  fingerprint: string
  rule: string
  severity: 'critical' | 'warn' | 'info'
  title: string
  body: string
  verbLabel: string
  verbHref: string
  impactValue: number | null
  itemId: string | null
  recipeId: string | null
  status: 'OPEN' | 'APPLIED' | 'SNOOZED' | 'DISMISSED'
  createdAt: string
}

export type InboxCategory = 'invoices' | 'exceptions' | 'prices' | 'variance' | 'other'

export interface InboxItem {
  id: string
  /** A batch is a stack of photos that is not invoices yet — it gets its own row treatment everywhere. */
  kind: 'invoice' | 'batch' | 'signal'
  category: InboxCategory
  tone: 'gold' | 'red' | 'blue' | 'ink' | 'ink3'
  icon: 'invoice' | 'batch' | 'price' | 'variance' | 'exception' | 'signal'
  title: string
  meta: string
  badge?: string
  impact?: string
  needsAction: boolean
  ageMs: number
  raw: SessionSummary | Signal
}

const STATUS_BADGE: Partial<Record<SessionStatus, string>> = {
  REVIEW: 'REVIEW', GROUPING: 'Unsorted', PROCESSING: 'OCR…', UPLOADING: 'UPLOAD…', APPROVING: 'APPLYING…', ERROR: 'ERROR',
}

function fmtMoney(n: number): string {
  return '$' + (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2).replace(/\.00$/, ''))
}

export function fmtAge(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * What a batch row can say about itself. `invoices` is the draft's group
 * count — null until the sorter has been opened once (no draft yet).
 */
export function batchSummary(s: Pick<SessionSummary, 'files' | 'groupingDraft'>): { photos: number; invoices: number | null } {
  const d = s.groupingDraft
  const groups = d && typeof d === 'object' && Array.isArray(d.groups) ? d.groups : null
  return { photos: s.files?.length ?? 0, invoices: groups ? groups.length : null }
}

const IMAGE_RE = /\.(jpe?g|png|heic|heif|webp)$/i
/** "Photo batch" when every file is an image, "File batch" when PDFs/CSVs are in the mix. */
export function batchTitle(s: Pick<SessionSummary, 'files'>): string {
  return s.files.every(f => IMAGE_RE.test(f.fileName)) ? 'Photo batch' : 'File batch'
}
export function batchNoun(s: Pick<SessionSummary, 'files'>, n: number): string {
  const photos = s.files.every(f => IMAGE_RE.test(f.fileName))
  return photos ? (n === 1 ? 'photo' : 'photos') : (n === 1 ? 'file' : 'files')
}

function batchToItem(s: SessionSummary): InboxItem {
  const { photos, invoices } = batchSummary(s)
  const meta = [
    `${photos} ${batchNoun(s, photos).toUpperCase()}`,
    invoices != null ? `${invoices} ${invoices === 1 ? 'INVOICE' : 'INVOICES'} FOUND` : 'NOT SORTED YET',
  ].join(' · ')
  return {
    id: `inv-${s.id}`,
    kind: 'batch',
    category: 'invoices',
    tone: 'blue',
    icon: 'batch',
    title: batchTitle(s),
    meta,
    badge: STATUS_BADGE.GROUPING,
    needsAction: true,
    ageMs: Date.now() - new Date(s.createdAt).getTime(),
    raw: s,
  }
}

function sessionToItem(s: SessionSummary): InboxItem | null {
  if (s.status === 'APPROVED' || s.status === 'REJECTED') return null
  if (s.status === 'GROUPING') return batchToItem(s)
  const isError = s.status === 'ERROR'
  const dateStr = s.invoiceDate
    ? new Date(s.invoiceDate).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })
    : ''
  const lines = s._count?.scanItems ?? 0
  const total = s.total ? Number(s.total) : null
  const metaBits = [
    s.invoiceNumber ? `INVOICE #${s.invoiceNumber}` : 'INVOICE',
    `${lines} ${lines === 1 ? 'LINE' : 'LINES'}`,
    total != null ? fmtMoney(total) : null,
  ].filter(Boolean)
  return {
    id: `inv-${s.id}`,
    kind: 'invoice',
    category: isError ? 'exceptions' : 'invoices',
    tone: isError ? 'red' : 'gold',
    icon: isError ? 'exception' : 'invoice',
    title: [s.supplierName ?? 'Unknown supplier', dateStr].filter(Boolean).join(' · '),
    meta: metaBits.join(' · '),
    badge: STATUS_BADGE[s.status],
    needsAction: s.status === 'REVIEW' || isError,
    ageMs: Date.now() - new Date(s.createdAt).getTime(),
    raw: s,
  }
}

function categoryOfRule(rule: string): InboxCategory {
  if (rule === 'PRICE_SPIKE' || rule === 'RECIPE_DRIFT') return 'prices'
  if (rule === 'COUNT_OVERDUE' || rule === 'WASTAGE_SPIKE') return 'variance'
  return 'other'
}

function signalToItem(sig: Signal): InboxItem | null {
  if (sig.status !== 'OPEN') return null
  const cat = categoryOfRule(sig.rule)
  const tone = sig.severity === 'critical' ? 'red' : sig.severity === 'warn' ? 'gold' : 'ink3'
  return {
    id: `sig-${sig.id}`,
    kind: 'signal',
    category: cat,
    tone,
    icon: cat === 'prices' ? 'price' : cat === 'variance' ? 'variance' : 'signal',
    title: sig.title,
    meta: sig.rule.replaceAll('_', ' ') + (sig.body ? ` · ${sig.body}` : ''),
    impact: sig.impactValue != null && sig.impactValue > 0 ? '+' + fmtMoney(sig.impactValue) : undefined,
    needsAction: sig.severity === 'critical',
    ageMs: Date.now() - new Date(sig.createdAt).getTime(),
    raw: sig,
  }
}

/** Merge sessions + signals → one sorted feed. needs-action first, then oldest first. */
export function toInboxItems(sessions: SessionSummary[], signals: Signal[]): InboxItem[] {
  const items = [
    ...sessions.map(sessionToItem),
    ...signals.map(signalToItem),
  ].filter((x): x is InboxItem => x !== null)
  return items.sort((a, b) => {
    if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1
    return b.ageMs - a.ageMs // oldest first
  })
}

export type ChipId = 'all' | InboxCategory
export const INBOX_CHIPS: { id: ChipId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'prices', label: 'Prices' },
  { id: 'variance', label: 'Variance' },
  { id: 'exceptions', label: 'Exceptions' },
]

export function inboxCounts(items: InboxItem[]): Record<ChipId, number> {
  const c: Record<ChipId, number> = { all: items.length, invoices: 0, prices: 0, variance: 0, exceptions: 0, other: 0 }
  for (const it of items) c[it.category] = (c[it.category] ?? 0) + 1
  return c
}

export function filterByChip(items: InboxItem[], chip: ChipId): InboxItem[] {
  if (chip === 'all') return items
  return items.filter(it => it.category === chip)
}
