'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, AlertTriangle } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { PICK_REASONS } from './reasons'
import { wasteUnits, wasteCost, fmtWasteQty, type WasteItem } from './units'
import { rankItems } from './search'
import { useBackDismiss } from '@/lib/back-stack'
import type { WasteDraft, SaveResult } from './types'

// The phone's Log waste form: a bottom sheet, not the old centred modal. Item →
// amount + unit → reason (big plain-word buttons, no default) → optional note →
// one full-width Save pinned to the bottom of the sheet, above the keyboard.
// After a save the sheet stays open and clears for the next entry ("log another");
// the page shows the "Logged … — Undo" toast.

/** Height the on-screen keyboard takes from the bottom of the layout viewport. */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    if (!active) return
    const vv = window.visualViewport
    if (!vv) return
    const on = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    on()
    vv.addEventListener('resize', on)
    vv.addEventListener('scroll', on)
    return () => { vv.removeEventListener('resize', on); vv.removeEventListener('scroll', on); setInset(0) }
  }, [active])
  return inset
}

const isTouch = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

const EMPTY = { itemId: '', qty: '', unit: '', reason: '', notes: '' }

export function LogWasteSheet({
  open, onClose, items, showMoney, rcError, onSave,
}: {
  open: boolean
  onClose: () => void
  items: WasteItem[]
  showMoney: boolean
  /** Set when no single revenue center is picked — saving is impossible. */
  rcError: string | null
  onSave: (draft: WasteDraft) => Promise<SaveResult>
}) {
  const [f, setF] = useState(EMPTY)
  useBackDismiss(open, onClose)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const qtyRef = useRef<HTMLInputElement>(null)
  const kb = useKeyboardInset(open)

  const item = items.find(i => i.id === f.itemId) ?? null
  const units = wasteUnits(item)
  const qty = parseFloat(f.qty.replace(',', '.'))
  const cost = showMoney ? wasteCost(item, qty, f.unit) : null
  const results = useMemo(() => rankItems(items, query, 8), [items, query])

  // Fresh form each time the sheet opens. Focus the search only with a mouse —
  // on a phone the keyboard would jump up over the sheet before the cook looks.
  useEffect(() => {
    if (!open) return
    setF(EMPTY); setQuery(''); setError(null)
    if (isTouch()) return
    const t = setTimeout(() => searchRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const pick = (it: WasteItem) => {
    setF(p => ({ ...p, itemId: it.id, unit: it.baseUnit }))
    setQuery('')
    setError(null)
    // Straight on to the amount (the keyboard is already up if they typed a search).
    setTimeout(() => qtyRef.current?.focus(), 0)
  }

  const missing = !item ? 'Pick an item'
    : !(qty > 0) ? 'Enter an amount'
    : !f.reason ? 'Pick a reason'
    : null
  const canSave = !missing && !rcError && !saving

  const save = async () => {
    if (!canSave || !item) return
    setSaving(true)
    setError(null)
    const res = await onSave({ inventoryItemId: item.id, qtyWasted: String(qty), unit: f.unit, reason: f.reason, notes: f.notes })
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    // Ready for the next one.
    setF(EMPTY)
    setQuery('')
    if (!isTouch()) setTimeout(() => searchRef.current?.focus(), 0)
  }

  return (
    // z-[90] clears the phone tab bar (z-50). md:hidden — desktop keeps its own form.
    <div className="md:hidden fixed inset-x-0 top-0 z-[90] flex items-end" style={{ bottom: kb }}>
      {/* Plain dim scrim — NO backdrop-blur (freezes iOS on a full-screen fixed layer). */}
      <div onClick={onClose} className="absolute inset-0 bg-[rgba(9,9,11,0.5)]" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Log waste"
        className="relative w-full bg-paper rounded-t-2xl shadow-2xl flex flex-col max-h-[calc(100%-1.5rem)]"
      >
        {/* header */}
        <div className="flex items-center gap-3 px-4 pt-3 pb-2 shrink-0">
          <h2 className="flex-1 text-[18px] font-semibold tracking-[-0.02em] text-ink">Log waste</h2>
          <button type="button" onClick={onClose} className="min-h-[44px] px-3 rounded-lg text-[15px] font-medium text-ink-2">
            Done
          </button>
        </div>

        {/* body — scrolls; the Save bar below never does */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-4 space-y-4">
          {/* item */}
          <div>
            <div className="text-[13px] font-medium text-ink-3 mb-1.5">Item</div>
            {item ? (
              <div className="flex items-center gap-2 border border-line rounded-xl pl-3.5 pr-1 min-h-[52px]">
                <span className="flex-1 min-w-0 text-[16px] font-semibold text-ink truncate">{item.itemName}</span>
                <button
                  type="button"
                  onClick={() => { setF(p => ({ ...p, itemId: '', unit: '' })); setTimeout(() => searchRef.current?.focus(), 0) }}
                  className="min-h-[44px] px-3 rounded-lg text-[14px] font-medium text-ink-2"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 border border-line rounded-xl px-3.5 min-h-[52px] focus-within:ring-2 focus-within:ring-gold">
                  <Search size={18} className="text-ink-4 shrink-0" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && results[0]) { e.preventDefault(); pick(results[0]) } }}
                    placeholder="Search items…"
                    enterKeyHint="search"
                    autoComplete="off"
                    autoCorrect="off"
                    className="flex-1 min-w-0 bg-transparent outline-none text-[16px] placeholder:text-ink-4"
                  />
                  {query && (
                    <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="w-9 h-9 grid place-items-center text-ink-4">
                      <X size={16} />
                    </button>
                  )}
                </div>
                <div className="mt-1.5 border border-line rounded-xl overflow-hidden divide-y divide-line">
                  {results.length === 0 ? (
                    <div className="px-3.5 py-3 text-[14px] text-ink-4">No matching items</div>
                  ) : results.map(it => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => pick(it)}
                      className="w-full flex items-center gap-2 px-3.5 min-h-[48px] text-left active:bg-bg-2"
                    >
                      <span className="flex-1 min-w-0 text-[15px] text-ink truncate">{it.itemName}</span>
                      {/* Price only for MANAGER+ — staff saw "$0.00/g" on every row. */}
                      {showMoney && it.pricePerBaseUnit != null && (
                        <span className="shrink-0 font-mono text-[12px] text-ink-3 tabular-nums">
                          {formatCurrency(Number(it.pricePerBaseUnit))}/{it.baseUnit}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* amount + unit */}
          {item && (
            <div>
              <div className="text-[13px] font-medium text-ink-3 mb-1.5">How much</div>
              <div className="flex gap-2">
                <input
                  ref={qtyRef}
                  value={f.qty}
                  onChange={e => setF(p => ({ ...p, qty: e.target.value.replace(/[^0-9.,]/g, '') }))}
                  onFocus={e => e.currentTarget.select()}
                  inputMode="decimal"
                  enterKeyHint="done"
                  placeholder="0"
                  aria-label="Amount"
                  className="w-32 border border-line rounded-xl px-3.5 min-h-[52px] font-mono text-[20px] font-semibold text-ink tabular-nums outline-none focus:ring-2 focus:ring-gold"
                />
                <div className="flex-1 flex gap-1.5 overflow-x-auto" role="radiogroup" aria-label="Unit">
                  {units.map(u => (
                    <button
                      key={u}
                      type="button"
                      role="radio"
                      aria-checked={f.unit === u}
                      onClick={() => setF(p => ({ ...p, unit: u }))}
                      className={`shrink-0 min-w-[52px] min-h-[52px] px-3 rounded-xl border text-[15px] font-medium ${f.unit === u ? 'bg-ink text-paper border-ink' : 'border-line text-ink-2'}`}
                    >
                      {u}
                    </button>
                  ))}
                </div>
              </div>
              {cost != null && cost > 0 && (
                <div className="mt-1.5 text-[13px] text-ink-3">About <span className="font-mono text-red font-semibold">{formatCurrency(cost)}</span></div>
              )}
            </div>
          )}

          {/* reason — a pick, never a default */}
          <div>
            <div className="text-[13px] font-medium text-ink-3 mb-1.5">Why</div>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Reason">
              {PICK_REASONS.map(r => {
                const on = f.reason === r.code
                return (
                  <button
                    key={r.code}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setF(p => ({ ...p, reason: r.code }))}
                    className={`min-h-[56px] px-3 py-2 rounded-xl border text-left ${on ? 'bg-ink text-paper border-ink' : 'border-line text-ink'}`}
                  >
                    <div className="text-[15px] font-semibold leading-tight">{r.label}</div>
                    <div className={`text-[12px] leading-tight mt-0.5 ${on ? 'text-paper/70' : 'text-ink-4'}`}>{r.hint}</div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* note */}
          <div>
            <div className="text-[13px] font-medium text-ink-3 mb-1.5">Note <span className="text-ink-4 font-normal">(optional)</span></div>
            <textarea
              value={f.notes}
              onChange={e => setF(p => ({ ...p, notes: e.target.value }))}
              rows={2}
              placeholder={f.reason === 'UNKNOWN' ? 'What happened?' : ''}
              className="w-full border border-line rounded-xl px-3.5 py-3 text-[16px] outline-none focus:ring-2 focus:ring-gold"
            />
          </div>

          {(rcError || error) && (
            <div className="bg-red-soft text-red-text rounded-xl p-3 text-[14px] flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{error ?? rcError}</span>
            </div>
          )}
        </div>

        {/* Save — pinned to the bottom of the sheet, which rides on top of the keyboard. */}
        <div
          className="shrink-0 border-t border-line bg-paper px-4 pt-3"
          style={{ paddingBottom: kb > 0 ? 12 : 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
        >
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="w-full min-h-[52px] rounded-xl bg-red text-white text-[16px] font-semibold disabled:bg-bg-2 disabled:text-ink-4"
          >
            {saving ? 'Saving…' : missing ?? `Log ${fmtWasteQty(qty, f.unit)}`}
          </button>
        </div>
      </div>
    </div>
  )
}
