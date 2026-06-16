'use client'
import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, Check, Minus, Plus } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useToast } from '@/components/Toast'
import { getCountableUoms, convertCountQtyToBase, convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'

export interface QuickCountItem {
  id: string
  itemName: string
  category?: string
  dimension?: string | null
  baseUnit: string
  packChain?: unknown
  countUnit?: string | null
  countUOM?: string
  lastCountQty?: number | string | null
}

interface Props {
  item: QuickCountItem
  onClose: () => void
  /** Fired after a successful count so the parent can refresh the list. */
  onDone?: (result: { variancePct: number; varianceCost: number }) => void
}

const f = (n: number) => (Number(n) % 1 === 0 ? Number(n).toFixed(0) : Number(n).toFixed(1))

export function QuickCountSheet({ item, onClose, onDone }: Props) {
  const { activeRc } = useRc()
  const toast = useToast()

  const dims = useMemo(() => ({
    dimension: item.dimension ?? 'COUNT',
    baseUnit:  item.baseUnit,
    packChain: item.packChain ?? [],
    countUnit: item.countUnit ?? item.countUOM ?? null,
  }), [item])

  const uoms       = useMemo(() => getCountableUoms(dims), [dims])
  const uomDisplay = (lbl: string) => uoms.find(u => u.label === lbl)?.display ?? lbl

  const [selectedUom, setSelectedUom] = useState(() => resolveCountUom(dims) || item.baseUnit)
  const [inputQty, setInputQty] = useState(0)
  const [caseQty, setCaseQty]   = useState(0)
  const [expectedBase, setExp]  = useState<number | null>(null)
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)

  const unitLabels = useMemo(
    () => Array.from(new Set([...uoms.map(u => u.label), selectedUom])),
    [uoms, selectedUom],
  )
  const stepBy    = /^(kg|l|lb|gal|qt)$/i.test(selectedUom) ? 0.1 : 1
  // Show the "cases" quick-add when the chain has a container level above the
  // leaf (e.g. case → each). Derived from the pack chain, not legacy pack cols.
  const chainArr  = (Array.isArray(item.packChain) ? item.packChain : []) as { unit: string; per: number }[]
  const topUnit   = chainArr[0]?.unit ?? ''
  const showCases = chainArr.length > 1 && /case|cs|box|ctn|pack|flat|tray|crate/i.test(topUnit)
  // base units in one top-level case (running product of the chain).
  const caseBase  = chainArr.reduce((acc, l) => acc * (Number(l?.per) || 0), 1)

  // Fetch theoretical on-hand for the active RC (for the live variance preview).
  useEffect(() => {
    let alive = true
    setLoading(true)
    fetch(`/api/inventory/count/${item.id}/quick?rcId=${activeRc?.id ?? ''}`)
      .then(r => r.json())
      .then(d => {
        if (!alive) return
        if (typeof d?.expectedBase === 'number') setExp(d.expectedBase)
        if (typeof d?.countUom === 'string' && d.countUom) setSelectedUom(d.countUom)
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [item.id, activeRc?.id])

  // The primary qty is in selectedUom; "+ unopened cases" adds whole top-level
  // cases (each = caseBase base units) on top, summed in base.
  const effBase        = convertCountQtyToBase(inputQty, selectedUom, dims) + (showCases ? caseQty * caseBase : 0)
  // Counted qty expressed in the selected display unit (for the variance line).
  const effDisplay     = convertBaseToCountUom(effBase, selectedUom, dims)
  const expectedDisplay = expectedBase != null ? convertBaseToCountUom(expectedBase, selectedUom, dims) : null
  const lastDisplay    = item.lastCountQty != null
    ? convertBaseToCountUom(Number(item.lastCountQty), selectedUom, dims)
    : null
  const liveVar = expectedBase != null && expectedBase > 0
    ? ((effBase - expectedBase) / expectedBase) * 100
    : null

  function pickUom(label: string) {
    if (label === selectedUom) return
    setSelectedUom(label)
    setInputQty(0)
    setCaseQty(0)
  }

  // Submit the count in BASE units (selectedUom = baseUnit) so the optional
  // "+ unopened cases" — which sums into effBase — is included exactly. `zero`
  // records a 0 count.
  async function submit(zero = false) {
    if (saving) return
    if (!activeRc) {
      toast.show({ type: 'error', title: 'Pick a revenue center to quick-count' })
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/inventory/count/${item.id}/quick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countedQty: zero ? 0 : effBase, selectedUom: item.baseUnit, rcId: activeRc.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.show({ type: 'error', title: 'Count failed', message: data?.error })
        setSaving(false)
        return
      }
      const pct = Number(data.variancePct ?? 0)
      toast.show({
        type: 'success',
        title: `Counted ${item.itemName}`,
        message: Math.abs(pct) < 0.1 ? 'Bang on — no variance.' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs theoretical`,
      })
      onDone?.({ variancePct: pct, varianceCost: Number(data.varianceCost ?? 0) })
      onClose()
    } catch {
      toast.show({ type: 'error', title: 'Count failed' })
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full sm:max-w-[420px] bg-paper rounded-t-2xl sm:rounded-2xl px-4 pb-8 sm:pb-6 pt-2 shadow-xl max-h-[92vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="w-9 h-1 bg-line rounded-full mx-auto mb-3 sm:hidden" />

        {/* Header */}
        <div className="flex items-start gap-3 mb-1">
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-semibold text-ink truncate tracking-[-0.02em]">{item.itemName}</div>
            <div className="font-mono text-[11px] text-ink-3 mt-0.5 truncate">
              {[item.category, activeRc ? `Counting ${activeRc.name}` : 'No revenue center'].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 -mr-1 text-ink-4 shrink-0"><X size={18} /></button>
        </div>

        {/* Unit tabs */}
        {unitLabels.length > 1 && (
          <div className="flex bg-bg-2 border border-line rounded-[10px] p-1 gap-0.5 mt-3 overflow-x-auto [&::-webkit-scrollbar]:hidden">
            {unitLabels.map(label => (
              <button key={label} onClick={() => pickUom(label)}
                className={`flex-1 min-w-[56px] py-1.5 text-[13px] font-medium rounded-[7px] transition-colors whitespace-nowrap ${selectedUom === label ? 'bg-paper shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-ink' : 'text-ink-3'}`}>
                {uomDisplay(label)}
              </button>
            ))}
          </div>
        )}

        {/* Big stepper */}
        <div className="text-center font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] mt-4 mb-2">{selectedUom} on hand</div>
        <div className="flex items-center gap-3">
          <button onClick={() => setInputQty(v => Math.max(0, Math.round((v - stepBy) * 100) / 100))}
            className="w-[60px] h-[60px] rounded-2xl bg-bg-2 border border-line grid place-items-center shrink-0 active:bg-line"><Minus size={26} className="text-ink-2" /></button>
          <input type="number" inputMode="decimal" value={inputQty} onChange={e => setInputQty(parseFloat(e.target.value) || 0)}
            onFocus={e => e.target.select()}
            className="flex-1 min-w-0 h-[60px] text-center text-[40px] font-semibold tracking-[-0.03em] border-2 border-gold rounded-2xl focus:outline-none text-ink" min={0} step={stepBy} />
          <button onClick={() => setInputQty(v => Math.round((v + stepBy) * 100) / 100)}
            className="w-[60px] h-[60px] rounded-2xl bg-ink grid place-items-center shrink-0 active:bg-ink-2"><Plus size={26} className="text-gold" /></button>
        </div>
        <div className="text-center font-mono text-[10.5px] text-ink-4 mt-2">tap to type</div>

        {/* Unopened cases */}
        {showCases && (
          <div className="flex items-center justify-between gap-3 border-t border-line mt-3 pt-3">
            <span className="font-mono text-[11px] text-ink-2 uppercase tracking-[0.03em]">+ unopened cases <span className="text-ink-4">({f(caseBase)} {item.baseUnit}/{topUnit || 'CS'})</span></span>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setCaseQty(v => Math.max(0, v - 1))} className="w-9 h-9 rounded-[9px] bg-bg-2 border border-line grid place-items-center active:bg-line"><Minus size={16} className="text-ink-2" /></button>
              <span className="w-6 text-center text-[16px] font-semibold tabular-nums">{caseQty}</span>
              <button onClick={() => setCaseQty(v => v + 1)} className="w-9 h-9 rounded-[9px] bg-ink grid place-items-center active:bg-ink-2"><Plus size={16} className="text-gold" /></button>
            </div>
          </div>
        )}

        {/* Variance vs theoretical + last count */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 mt-4 px-3 py-2.5 rounded-[10px] bg-bg-2 font-mono text-[11px] text-ink-4">
            <Loader2 size={13} className="animate-spin" /> loading theoretical…
          </div>
        ) : expectedBase != null && expectedBase > 0 && expectedDisplay != null && (() => {
          const onTrack = liveVar !== null && Math.abs(liveVar) < 2
          const short   = liveVar !== null && liveVar < 0
          const bg = onTrack ? 'bg-bg-2' : short ? 'bg-red-soft' : 'bg-gold-soft'
          const fg = onTrack ? 'text-ink-3' : short ? 'text-red-text' : 'text-gold-2'
          const delta = effDisplay - expectedDisplay
          return (
            <div className={`flex items-center justify-between gap-2 mt-4 px-3 py-2.5 rounded-[10px] font-mono text-[11px] ${bg}`}>
              <span className="text-ink-3">
                Expected <b className="text-ink-2 font-medium">{expectedDisplay.toFixed(1)} {selectedUom}</b>
                {lastDisplay != null && <> · last {f(lastDisplay)} {selectedUom}</>}
              </span>
              <span className={`font-semibold whitespace-nowrap ${fg}`}>
                {onTrack ? 'on track' : `${delta > 0 ? '+' : ''}${f(delta)} ${selectedUom}`}
              </span>
            </div>
          )
        })()}

        {/* Save */}
        <button onClick={() => submit()} disabled={saving || !activeRc}
          className="w-full h-12 bg-ink text-paper rounded-[12px] font-semibold text-[15px] flex items-center justify-center gap-2 mt-4 disabled:opacity-50">
          {saving ? <Loader2 size={17} className="animate-spin" /> : <Check size={17} className="text-gold" />} Save count
        </button>
        <div className="flex gap-2 mt-2">
          <button onClick={() => submit(true)} disabled={saving || !activeRc}
            className="flex-1 h-10 border border-gold-soft bg-gold-soft text-gold-2 rounded-[10px] text-[12.5px] font-semibold disabled:opacity-50">Out of stock</button>
          <button onClick={onClose} disabled={saving}
            className="flex-1 h-10 border border-line rounded-[10px] text-[12.5px] text-ink-3 font-medium disabled:opacity-50">Cancel</button>
        </div>
      </div>
    </div>
  )
}
