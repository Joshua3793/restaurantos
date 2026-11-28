'use client'
// "No item has this barcode yet — which item is it?" A cook searches, picks the
// item, and the barcode is saved on it (POST /api/inventory/[id]/barcode), so
// the next scan finds it straight away. Replacing an item's existing barcode is
// a manager job — the server says so if a cook tries.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search, X, Loader2, ScanLine, ChevronRight } from 'lucide-react'
import { useBackDismiss } from '@/lib/back-stack'

export interface ScannedItem { id: string; itemName: string }
interface Hit { id: string; itemName: string; category?: string | null; barcode?: string | null }

export function LinkBarcodeSheet({
  open, code, onClose, onLinked, onScanAgain,
}: {
  open: boolean
  code: string
  onClose: () => void
  onLinked: (item: ScannedItem) => void
  onScanAgain?: () => void
}) {
  useBackDismiss(open, onClose)
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <LinkView code={code} onClose={onClose} onLinked={onLinked} onScanAgain={onScanAgain} />,
    document.body,
  )
}

function LinkView({ code, onClose, onLinked, onScanAgain }: {
  code: string
  onClose: () => void
  onLinked: (item: ScannedItem) => void
  onScanAgain?: () => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [searching, setSearching] = useState(false)
  const [confirm, setConfirm] = useState<Hit | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setHits([]); setSearching(false); return }
    const my = ++seq.current
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/inventory/search?q=${encodeURIComponent(term)}&limit=12`)
        const rows: Hit[] = res.ok ? await res.json() : []
        if (my === seq.current) setHits(Array.isArray(rows) ? rows : [])
      } catch {
        if (my === seq.current) setHits([])
      } finally {
        if (my === seq.current) setSearching(false)
      }
    }, 220)
    return () => clearTimeout(t)
  }, [q])

  const link = async (hit: Hit) => {
    setSaving(hit.id)
    setError(null)
    try {
      const res = await fetch(`/api/inventory/${hit.id}/barcode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode: code }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body?.error ?? 'Could not save the barcode. Try again.')
        setConfirm(null)
        return
      }
      onLinked({ id: hit.id, itemName: hit.itemName })
    } catch {
      setError('No signal — the barcode was not saved. Try again.')
      setConfirm(null)
    } finally {
      setSaving(null)
    }
  }

  const pick = (hit: Hit) => {
    if (hit.barcode && hit.barcode !== code) { setConfirm(hit); return }
    void link(hit)
  }

  return (
    <div className="fixed inset-0 z-[105] flex items-end" role="dialog" aria-label="Link this barcode">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full md:max-w-lg md:mx-auto md:mb-8 bg-paper text-ink rounded-t-2xl md:rounded-2xl shadow-xl flex flex-col max-h-[88dvh]" style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 12px)' }}>
        <div className="flex items-start gap-2 px-4 pt-4 pb-2">
          <div className="flex-1 min-w-0">
            <div className="text-[18px] font-semibold tracking-[-0.02em]">No item has this barcode yet</div>
            <div className="text-[16px] text-ink-3 mt-0.5">Which item is it? <span className="font-mono text-[14px]">{code}</span></div>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-11 h-11 -mr-2 -mt-2 grid place-items-center rounded-full text-ink-3">
            <X size={20} />
          </button>
        </div>

        {confirm ? (
          <div className="px-4 pb-3 flex flex-col gap-3">
            <div className="rounded-xl border border-line p-3 text-[16px] leading-snug">
              <span className="font-semibold">{confirm.itemName}</span> already has a different barcode
              (<span className="font-mono text-[14px]">{confirm.barcode}</span>). Replace it with this one?
            </div>
            <div className="flex gap-2">
              <button onClick={() => setConfirm(null)} className="flex-1 h-11 rounded-[10px] border border-line text-[16px]">Back</button>
              <button
                onClick={() => link(confirm)}
                disabled={saving !== null}
                className="flex-1 h-11 rounded-[10px] bg-ink text-paper text-[16px] font-semibold disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {saving && <Loader2 size={16} className="animate-spin" />} Replace
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 pb-2">
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
                <input
                  type="search"
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="Search items…"
                  enterKeyHint="search"
                  autoComplete="off"
                  className="w-full h-11 pl-9 pr-3 border border-line rounded-[10px] text-[16px] bg-paper text-ink focus:outline-none focus:border-ink-3 placeholder:text-ink-3"
                />
              </div>
              {error && <div className="mt-2 text-[15px] text-red-text">{error}</div>}
            </div>
            <div className="flex-1 overflow-y-auto px-2 min-h-[120px]">
              {searching && hits.length === 0 && (
                <div className="py-6 grid place-items-center text-ink-3"><Loader2 size={20} className="animate-spin" /></div>
              )}
              {!searching && q.trim().length >= 2 && hits.length === 0 && (
                <div className="py-6 text-center text-[16px] text-ink-3">No items match “{q.trim()}”.</div>
              )}
              {q.trim().length < 2 && (
                <div className="py-6 text-center text-[16px] text-ink-3">Type a couple of letters of the item’s name.</div>
              )}
              {hits.map(h => (
                <button
                  key={h.id}
                  onClick={() => pick(h)}
                  disabled={saving !== null}
                  className="w-full min-h-[48px] flex items-center gap-3 px-2 py-2 rounded-xl text-left active:bg-bg disabled:opacity-60"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-[16px] font-medium truncate">{h.itemName}</span>
                    {(h.category || h.barcode) && (
                      <span className="block text-[13px] text-ink-3 truncate">
                        {h.category}{h.barcode ? `${h.category ? ' · ' : ''}has a barcode` : ''}
                      </span>
                    )}
                  </span>
                  {saving === h.id ? <Loader2 size={16} className="animate-spin text-ink-3" /> : <ChevronRight size={16} className="text-ink-4" />}
                </button>
              ))}
            </div>
            {onScanAgain && (
              <div className="px-4 pt-2">
                <button onClick={onScanAgain} className="w-full h-11 rounded-[10px] border border-line text-[16px] flex items-center justify-center gap-2">
                  <ScanLine size={18} /> Scan again
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
