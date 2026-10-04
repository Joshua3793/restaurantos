'use client'
// Supplier wordings section for the inventory item drawer (W7): how each
// supplier writes this item on its invoices, learned when an invoice is
// approved. Grouped by supplier — the wording, its product code, the pack it
// came in, how often it was seen and when last. A manager can forget a wrong
// one (✕); the next invoice with it then needs matching again. No adding by
// hand: wordings are only learned from approved invoices.
// Data: GET /api/inventory/[id]/aliases; write: DELETE …/aliases/[aliasId].

import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { CollapsibleSection } from './drawer/CollapsibleSection'

interface Wording {
  id: string
  supplierId: string
  supplierName: string
  rawText: string
  supplierItemCode: string | null
  packLabel: string
  useCount: number
  lastUsed: string
}

/** "28 Sep" — the day it was last seen, on the restaurant's (Pacific) calendar. */
function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'America/Vancouver' })
}

/** Rows grouped by supplier, in the order the server sent them. */
function bySupplier(rows: Wording[]): Array<{ supplierId: string; supplierName: string; rows: Wording[] }> {
  const groups = new Map<string, { supplierId: string; supplierName: string; rows: Wording[] }>()
  for (const w of rows) {
    const g = groups.get(w.supplierId) ?? { supplierId: w.supplierId, supplierName: w.supplierName, rows: [] }
    g.rows.push(w)
    groups.set(w.supplierId, g)
  }
  return Array.from(groups.values())
}

function wordingMeta(w: Wording): string {
  return [
    w.supplierItemCode ? `#${w.supplierItemCode}` : null,
    w.packLabel !== '—' ? w.packLabel : null,
    `seen ${w.useCount}×`,
    `last ${shortDay(w.lastUsed)}`,
  ].filter(Boolean).join(' · ')
}

/** `refreshKey` — the drawer's merge counter: a merge moves the absorbed
 *  item's wordings onto this one, so the list reloads when it changes. */
export function SupplierWordingsSection({ itemId, refreshKey = 0 }: { itemId: string; refreshKey?: number }) {
  const [wordings, setWordings] = useState<Wording[] | null>(null)
  // A failed load is NOT "nothing learned" — it gets its own sentence.
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch(`/api/inventory/${itemId}/aliases`)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then(d => {
        if (!Array.isArray(d?.aliases)) throw new Error('bad shape')
        setWordings(d.aliases)
        setLoadFailed(false)
      })
      .catch(() => setLoadFailed(true))
  }, [itemId])

  useEffect(() => { load() }, [load, refreshKey])

  const forget = async (w: Wording) => {
    setError(null)
    if (!confirm(`Forget this wording? The next invoice from ${w.supplierName} with it will need matching again.`)) return
    setBusy(w.id)
    try {
      const res = await fetch(`/api/inventory/${itemId}/aliases/${w.id}`, { method: 'DELETE' }).catch(() => null)
      if (!res) { setError('Could not reach the server. Try again.'); return }
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? `Could not forget it (${res.status}). Try again.`)
      }
      load()
    } finally {
      setBusy(null)
    }
  }

  if (loadFailed) {
    return (
      <CollapsibleSection
        name="wordings"
        title="Supplier wordings"
        heading={
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 font-semibold">
            Supplier wordings
          </div>
        }
      >
        <p className="text-[12px] text-red-text">
          Couldn&apos;t load the supplier wordings.{' '}
          <button type="button" onClick={load} className="font-semibold underline underline-offset-2">
            Try again.
          </button>
        </p>
      </CollapsibleSection>
    )
  }

  if (!wordings) return null

  return (
    <CollapsibleSection
      name="wordings"
      title="Supplier wordings"
      aside={wordings.length}
      heading={
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 font-semibold">
          Supplier wordings · {wordings.length}
        </div>
      }
    >
      {wordings.length === 0 ? (
        <p className="text-[12px] text-ink-4">No wordings learned yet — they are learned from approved invoices.</p>
      ) : (
        <div className="border border-line rounded-lg divide-y divide-line overflow-hidden">
          {bySupplier(wordings).map(g => (
            <div key={g.supplierId} className="bg-paper">
              <div className="px-3 pt-2.5 pb-1 text-[13px] font-medium text-ink">{g.supplierName}</div>
              {g.rows.map(w => (
                <div key={w.id} className="flex items-center gap-3 px-3 py-1.5 last:pb-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-[12px] text-ink-2 break-words">{w.rawText}</div>
                    <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">{wordingMeta(w)}</div>
                  </div>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => forget(w)}
                    title="Forget this wording"
                    aria-label={`Forget the wording ${w.rawText}`}
                    className="shrink-0 p-1 text-ink-4 hover:text-red-text disabled:opacity-50"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-red-text">{error}</p>}
    </CollapsibleSection>
  )
}
