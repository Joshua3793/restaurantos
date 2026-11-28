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
  REVIEW: 'REVIEW', GROUPING: 'Unsorted', PROCESSING: 'READING…', UPLOADING: 'UPLOAD…', APPROVING: 'APPLYING…', ERROR: 'ERROR',
}

/** The scanner is still reading this invoice (or its photos are still arriving):
 *  there are no lines yet, so the review must not open — it would show an empty
 *  invoice with an Approve button. */
export function isStillReading(s: Pick<SessionSummary, 'status'>): boolean {
  return s.status === 'PROCESSING' || s.status === 'UPLOADING'
}

/** The note a tap on a still-reading card shows instead of opening the review. */
export const STILL_READING_NOTE = 'Still reading — it opens here when it’s ready.'

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

/** The reason the sessions-list sweeper writes on an upload whose photos never arrived. */
export const UPLOAD_NEVER_FINISHED = "Upload didn't finish — no photos arrived. Delete it and scan again."

/** An UPLOADING session older than this is treated as dead, not in flight. */
const UPLOAD_GRACE_MS = 2 * 60 * 1000

/**
 * Can this session be thrown away straight from the inbox? Only when nothing
 * was ever scanned from it (no lines → nothing to roll back, and the server
 * lets any uploader delete it), and it is not mid-flight:
 *   - GROUPING — an unsorted batch;
 *   - ERROR    — a failed scan or a dead upload;
 *   - UPLOADING past a short grace — the photos never arrived (the sweeper
 *     turns these into ERROR after 10 min; this covers the gap before that).
 * PROCESSING / APPROVING are excluded: something is still working on them.
 */
export function canDiscardFromInbox(
  s: Pick<SessionSummary, 'status' | 'createdAt' | 'parentSessionId' | '_count'>,
  now = Date.now(),
): boolean {
  if (s.parentSessionId) return false
  if ((s._count?.scanItems ?? 0) > 0) return false
  if (s.status === 'GROUPING' || s.status === 'ERROR') return true
  if (s.status === 'UPLOADING') return now - new Date(s.createdAt).getTime() > UPLOAD_GRACE_MS
  return false
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
  // While the scanner reads, nothing on the session is known yet — no supplier,
  // no lines. Say what is happening instead of "Unknown supplier · 0 lines".
  // (An UPLOADING session with no photos is a dead upload — it keeps the plain
  // card so its "didn't finish" note and Delete chip still read right.)
  if (isStillReading(s) && s.files.length > 0) {
    const pages = s.files.length
    return {
      id: `inv-${s.id}`,
      kind: 'invoice',
      category: 'invoices',
      tone: 'gold',
      icon: 'invoice',
      title: s.status === 'UPLOADING' ? 'Sending invoice…' : 'Reading invoice…',
      meta: `${pages} ${pages === 1 ? 'PAGE' : 'PAGES'} · ABOUT 30 SECONDS`,
      badge: STATUS_BADGE[s.status],
      needsAction: false,
      ageMs: Date.now() - new Date(s.createdAt).getTime(),
      raw: s,
    }
  }
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
/** The phone inbox opens on Invoices — every invoice, batch and failed scan,
 *  and nothing else. Recipe and price alerts ("Side Pulled Pork drifted") live
 *  under their own chips, and All comes last. */
export const DEFAULT_CHIP: ChipId = 'invoices'
export const INBOX_CHIPS: { id: ChipId; label: string }[] = [
  { id: 'invoices', label: 'Invoices' },
  { id: 'exceptions', label: 'Exceptions' },
  { id: 'prices', label: 'Prices' },
  { id: 'variance', label: 'Variance' },
  { id: 'all', label: 'All' },
]

export function inboxCounts(items: InboxItem[]): Record<ChipId, number> {
  const c: Record<ChipId, number> = { all: items.length, invoices: 0, prices: 0, variance: 0, exceptions: 0, other: 0 }
  for (const it of items) {
    if (it.kind !== 'signal') c.invoices++
    if (it.category !== 'invoices') c[it.category] = (c[it.category] ?? 0) + 1
  }
  return c
}

export function filterByChip(items: InboxItem[], chip: ChipId): InboxItem[] {
  if (chip === 'all') return items
  // Invoices = every session card (a failed scan included), never an alert.
  if (chip === 'invoices') return items.filter(it => it.kind !== 'signal')
  return items.filter(it => it.category === chip)
}

/** "Did Sysco go in?" — today's invoices that are in or on their way in:
 *  scanned today, or dated today. Batches, failed and rejected scans are left
 *  out; they are not deliveries yet. Newest first. `now` is the phone's own
 *  clock, which is the kitchen's day. */
export function todaysDeliveries(sessions: SessionSummary[], now = new Date()): SessionSummary[] {
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = ymd(now)
  const keep: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['PROCESSING', 'REVIEW', 'APPROVING', 'APPROVED'])
  return sessions
    .filter(s => keep.has(s.status) && !s.parentSessionId)
    .filter(s => ymd(new Date(s.createdAt)) === today || (s.invoiceDate ?? '').slice(0, 10) === today)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}
