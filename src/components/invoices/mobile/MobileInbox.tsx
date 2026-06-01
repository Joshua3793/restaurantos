'use client'
import { useMemo, useState } from 'react'
import { Upload, Camera, Inbox as InboxIcon } from 'lucide-react'
import type { SessionSummary } from '@/components/invoices/types'
import { Signal, toInboxItems, inboxCounts, filterByChip, fmtAge, ChipId, InboxItem } from '@/lib/invoices/inbox-items'
import { InboxChips } from './InboxChips'
import { InboxInvoiceCard } from './InboxInvoiceCard'
import { InboxSignalCard } from './InboxSignalCard'
import { SignalSheet } from './SignalSheet'

const EMPTY_TEXT: Record<ChipId, string> = {
  all: 'Inbox is empty — nothing needs you.',
  invoices: 'No invoices in the queue.',
  prices: 'No price alerts.',
  variance: 'No variance or wastage alerts.',
  exceptions: 'No exceptions to resolve.',
  other: 'Nothing here.',
}

export function MobileInbox({ sessions, signals, onSelectSession, onUploadClick, onScanClick, onSignalAct }: {
  sessions: SessionSummary[]
  signals: Signal[]
  onSelectSession: (id: string) => void
  onUploadClick: () => void
  onScanClick?: () => void
  onSignalAct: (id: string, action: 'apply' | 'snooze' | 'dismiss') => void
}) {
  const [chip, setChip] = useState<ChipId>('all')
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
          {onScanClick && (
            <button onClick={onScanClick} className="w-10 h-10 rounded-xl bg-paper border border-line grid place-items-center text-ink-2 active:bg-bg-2"><Camera size={17} /></button>
          )}
          <button onClick={onUploadClick} className="inline-flex items-center gap-1.5 px-3.5 h-10 rounded-xl bg-ink text-paper text-[13px] font-medium active:bg-ink-2">
            <Upload size={15} className="text-gold" /> Upload
          </button>
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
          {visible.map(it => it.kind === 'invoice'
            ? <InboxInvoiceCard key={it.id} item={it} onOpen={onSelectSession} />
            : <InboxSignalCard key={it.id} item={it} onOpen={setSheet} />
          )}
        </div>
      )}

      <SignalSheet item={sheet} onClose={() => setSheet(null)} onAct={(id, action) => { onSignalAct(id, action); setSheet(null) }} />
    </div>
  )
}
