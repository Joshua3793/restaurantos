'use client'
import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { reasonLabel } from './reasons'
import { fmtWasteQty } from './units'
import { loggedAtOf, hasLoggedTime } from './logged-at'
import type { WasteLogRow } from './types'

const TIME = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' })

/** One waste entry on the phone: item, amount, reason in words, who, when. */
export function WasteCard({
  log, showMoney, onDelete,
}: {
  log: WasteLogRow
  showMoney: boolean
  /** Resolves false when the delete failed (the card stays). */
  onDelete: (id: string) => Promise<boolean>
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const time = hasLoggedTime(log) ? TIME.format(loggedAtOf(log)) : null
  const cost = log.costImpact == null ? null : Number(log.costImpact)

  const confirm = async () => {
    setBusy(true)
    const ok = await onDelete(log.id)
    setBusy(false)
    if (!ok) setConfirming(false)
  }

  return (
    <div className="bg-paper border border-line rounded-xl">
      <div className="flex items-start gap-2 p-3.5 pr-1.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="flex-1 min-w-0 text-[16px] font-semibold text-ink leading-snug">{log.inventoryItem.itemName}</span>
            <span className="shrink-0 font-mono text-[16px] font-semibold text-ink tabular-nums">{fmtWasteQty(log.qtyWasted, log.unit)}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[13px] text-ink-3">
            <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-bg-2 text-ink-2 font-medium">{reasonLabel(log.reason)}</span>
            <span>{log.loggedBy}</span>
            {time && <span>· {time}</span>}
            {showMoney && cost != null && <span className="ml-auto font-mono text-red tabular-nums">{formatCurrency(cost)}</span>}
          </div>
          {log.notes && <div className="mt-1.5 text-[13px] text-ink-2 leading-snug">{log.notes}</div>}
        </div>
        {log.canDelete && !confirming && (
          <button
            type="button"
            aria-label={`More for ${log.inventoryItem.itemName}`}
            onClick={() => setConfirming(true)}
            className="shrink-0 w-11 h-11 -mt-1.5 grid place-items-center rounded-lg text-ink-3 active:bg-bg-2"
          >
            <MoreHorizontal size={18} />
          </button>
        )}
      </div>
      {confirming && (
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
          <span className="flex-1 text-[14px] text-ink-2">Delete this entry?</span>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="min-h-[44px] px-4 rounded-lg border border-line text-[14px] text-ink-2"
          >
            Keep
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="min-h-[44px] px-4 rounded-lg bg-red text-white text-[14px] font-semibold disabled:opacity-60"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  )
}
