'use client'
import { useMemo, useState } from 'react'
import { Upload, Camera, Inbox as InboxIcon, Truck } from 'lucide-react'
import type { SessionSummary, SessionStatus } from '@/components/invoices/types'
import { Signal, toInboxItems, inboxCounts, filterByChip, fmtAge, ChipId, InboxItem, DEFAULT_CHIP, todaysDeliveries } from '@/lib/invoices/inbox-items'
import { useUser } from '@/contexts/UserContext'
import { atLeast } from '@/lib/roles'
import { formatCurrency } from '@/lib/invoice/formatters'
import { InboxChips } from './InboxChips'
import { InboxInvoiceCard } from './InboxInvoiceCard'
import { InboxSignalCard } from './InboxSignalCard'
import { SignalSheet } from './SignalSheet'

const DELIVERY_STATUS: Partial<Record<SessionStatus, { label: string; cls: string }>> = {
  APPROVED:   { label: 'In',               cls: 'bg-green-soft text-green-text' },
  APPROVING:  { label: 'Going in…',        cls: 'bg-blue-soft text-blue-text' },
  REVIEW:     { label: 'Waiting',          cls: 'bg-gold-soft text-gold-2' },
  PROCESSING: { label: 'Reading…',         cls: 'bg-bg-2 text-ink-3' },
}

/** "Did Sysco go in?" — read-only: who delivered today and where each invoice is. */
function TodaysDeliveries({ sessions, showMoney }: { sessions: SessionSummary[]; showMoney: boolean }) {
  return (
    <section className="pt-2" aria-label="Today's deliveries">
      <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] flex items-center gap-1.5 mb-2">
        <Truck size={11} /> Today’s deliveries
      </div>
      {sessions.length === 0 ? (
        <p className="text-[13px] text-ink-3 bg-paper border border-line rounded-xl px-3 py-3">No invoices in yet today.</p>
      ) : (
        <ul className="bg-paper border border-line rounded-xl divide-y divide-line">
          {sessions.map(s => {
            const st = DELIVERY_STATUS[s.status]
            const total = s.total != null && s.total !== '' ? Number(s.total) : null
            return (
              <li key={s.id} className="flex items-center gap-3 px-3 min-h-[48px] py-2">
                <span className="flex-1 min-w-0 text-[14px] text-ink truncate">
                  {s.supplierName ?? (s.status === 'PROCESSING' ? 'Reading invoice…' : 'Supplier not read')}
                </span>
                {showMoney && total != null && Number.isFinite(total) && (
                  <span className="font-mono text-[12.5px] text-ink-2 shrink-0">{formatCurrency(total)}</span>
                )}
                {st && <span className={`font-mono text-[10px] font-semibold px-2 py-1 rounded-full shrink-0 ${st.cls}`}>{st.label}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const EMPTY_TEXT: Record<ChipId, string> = {
  all: 'Inbox is empty — nothing needs you.',
  invoices: 'No invoices in the queue.',
  prices: 'No price alerts.',
  variance: 'No variance or wastage alerts.',
  exceptions: 'No exceptions to resolve.',
  other: 'Nothing here.',
}

export function MobileInbox({ sessions, signals, onSelectSession, onUploadClick, onScanClick, onSignalAct, onDiscardBatch, onRetry }: {
  sessions: SessionSummary[]
  signals: Signal[]
  onSelectSession: (id: string) => void
  onUploadClick: () => void
  onScanClick?: () => void
  onSignalAct: (id: string, action: 'apply' | 'snooze' | 'dismiss') => void
  /** Throw an unsorted batch away from its card (the page owns the confirm). */
  onDiscardBatch?: (id: string) => void
  /** Run a failed scan through OCR again (same handler as the desktop history list). */
  onRetry?: (id: string) => void
}) {
  const [chip, setChip] = useState<ChipId>(DEFAULT_CHIP)
  const { role } = useUser()
  // Default-deny while /api/me is in flight; LEAD+ sees invoice money.
  const showMoney = role !== null && atLeast(role, 'LEAD')
  const deliveries = useMemo(() => todaysDeliveries(sessions), [sessions])
  const [sheet, setSheet] = useState<InboxItem | null>(null)

  const items = useMemo(() => toInboxItems(sessions, signals), [sessions, signals])
  const counts = useMemo(() => inboxCounts(items), [items])
  const visible = useMemo(() => filterByChip(items, chip), [items, chip])
  const oldest = items.length ? fmtAge((items[items.length - 1].raw as { createdAt: string }).createdAt) : null

  return (
    <div className="space-y-3">
      {/* Compact header */}
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] flex items-center gap-1.5">
            <InboxIcon size={11} /> INBOX / INVOICES
          </div>
          <h1 className="text-[26px] font-semibold text-ink tracking-[-0.03em] leading-none mt-1">Invoices</h1>
          <div className="font-mono text-[10.5px] text-ink-4 mt-1.5">
            {items.length} {items.length === 1 ? 'ITEM' : 'ITEMS'}{oldest ? ` · OLDEST ${oldest.toUpperCase()} AGO` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Scan (camera) is the primary action when available; upload drops to a
              secondary icon. Without a camera (web), upload keeps the primary style. */}
          {onScanClick ? (
            <button onClick={onUploadClick} className="w-10 h-10 rounded-xl bg-paper border border-line grid place-items-center text-ink-2 active:bg-bg-2"><Upload size={17} /></button>
          ) : (
            <button onClick={onUploadClick} className="inline-flex items-center gap-1.5 px-3.5 h-10 rounded-xl bg-ink text-paper text-[13px] font-medium active:bg-ink-2">
              <Upload size={15} className="text-gold" /> Upload
            </button>
          )}
          {onScanClick && (
            <button onClick={onScanClick} className="inline-flex items-center gap-1.5 px-3.5 h-10 rounded-xl bg-ink text-paper text-[13px] font-medium active:bg-ink-2">
              <Camera size={15} className="text-gold" /> Scan
            </button>
          )}
        </div>
      </div>

      <InboxChips active={chip} counts={counts} onPick={setChip} />

      {visible.length === 0 ? (
        <div className="bg-paper border border-line rounded-xl py-10 text-center">
          <p className="font-mono text-[11px] text-green-text uppercase tracking-[0.06em]">All clear</p>
          <p className="text-[13px] text-ink-3 mt-1">{EMPTY_TEXT[chip]}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {visible.map(it => it.kind !== 'signal'
            ? <InboxInvoiceCard key={it.id} item={it} onOpen={onSelectSession} onDiscardBatch={onDiscardBatch} onRetry={onRetry} />
            : <InboxSignalCard key={it.id} item={it} onOpen={setSheet} />
          )}
        </div>
      )}

      <TodaysDeliveries sessions={deliveries} showMoney={showMoney} />

      <SignalSheet item={sheet} onClose={() => setSheet(null)} onAct={(id, action) => { onSignalAct(id, action); setSheet(null) }} />
    </div>
  )
}
