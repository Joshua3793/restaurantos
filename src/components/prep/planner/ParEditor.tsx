'use client'
// Smart Prep — fix a par right from the row. The par lives on the linked
// recipe's prep settings; the editor shows what the new par would do before
// saving ("With 5 kg, Kimchi reads at par — nothing to make").
import { useState } from 'react'
import { Minus, Plus, Check } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import { prepStep, suggestedBatches, suggestedDraftQty, batchesToQty } from '@/lib/prep-plan'
import { fmtAmount, stepOnGrid } from '@/lib/prep-amount'
import { parFlag } from '@/lib/prep-smart'

const half = (n: number) => (n === 0.5 ? '½' : n % 1 === 0.5 ? `${Math.floor(n)}½` : String(n))

function outcome(item: PrepItemRich, par: number): string {
  const next = { ...item, parLevel: par }
  const f = parFlag(next)
  if (f === 'NONE') return `With no par, ${item.name} is never suggested.`
  if (f === 'WRONG') return `${fmtAmount(par, item.unit)} still looks wrong — check the unit.`
  if ((item.onHand ?? 0) >= par) return `With ${fmtAmount(par, item.unit)}, ${item.name} reads at par (${fmtAmount(item.onHand ?? 0, item.unit)} on hand) — nothing to make.`
  const nb = suggestedBatches(next)
  const amount = nb != null && nb > 0
    ? `${half(nb)} ${nb > 1 ? 'batches' : 'batch'} (${fmtAmount(batchesToQty(next, nb), item.unit)})`
    : fmtAmount(suggestedDraftQty(next), item.unit)
  return `With ${fmtAmount(par, item.unit)}, Smart Prep suggests ${amount}.`
}

export function ParEditor({ item, onSave, onClose, sheet = false }: {
  item: PrepItemRich
  onSave: (par: number) => Promise<boolean>
  onClose: () => void
  /** phone: a bottom sheet, so Save is never cut off by the list pane */
  sheet?: boolean
}) {
  const was = item.parLevel ?? 0
  const step = prepStep(item.unit)
  const [text, setText] = useState(String(was > 0 && parFlag(item) !== 'WRONG' ? was : ''))
  const [saving, setSaving] = useState(false)
  const par = Number(text)
  const valid = text.trim() !== '' && Number.isFinite(par) && par >= 0
  const nudge = (dir: 1 | -1) => setText(String(stepOnGrid(valid ? par : 0, step, dir)))
  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    const ok = await onSave(par)
    setSaving(false)
    if (ok) onClose()
  }
  return (
    <>
      <span className={`fixed inset-0 z-40 ${sheet ? 'bg-[rgba(9,9,11,0.45)]' : ''}`} onClick={onClose} />
      <div role="dialog" aria-label={`${item.name} — par`}
        className={sheet
          ? 'fixed left-0 right-0 bottom-0 z-50 bg-paper rounded-t-2xl p-4 pb-8 flex flex-col gap-3 text-left'
          : 'absolute right-0 top-[calc(100%+6px)] z-50 w-[300px] max-w-[calc(100vw-32px)] bg-paper border border-line-2 rounded-xl shadow-[0_14px_34px_-10px_rgba(9,9,11,0.28)] p-3.5 flex flex-col gap-2.5 text-left'}>
        <div className="text-[14px] font-semibold text-ink">{item.name} — par</div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-stretch h-11 border border-line rounded-[9px] overflow-hidden bg-bg-2">
            <button type="button" onClick={() => nudge(-1)} aria-label="Less" className="w-10 grid place-items-center"><Minus size={15} className="text-ink-2" /></button>
            <input value={text} onChange={e => setText(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" aria-label="Par"
              className="w-[84px] bg-paper text-center font-mono text-[15px] font-semibold text-ink outline-none" />
            <button type="button" onClick={() => nudge(1)} aria-label="More" className="w-10 grid place-items-center"><Plus size={15} className="text-ink-2" /></button>
          </span>
          <span className="text-[13px] font-medium text-ink-2">{item.unit === 'l' ? 'L' : item.unit}</span>
        </div>
        <div className="text-[12.5px] text-ink-3">was {fmtAmount(was, item.unit)}</div>
        {valid && <div className="text-[12.5px] text-ink-2 leading-snug">{outcome(item, par)}</div>}
        <div className="text-[12px] text-ink-3">Saved on the recipe&apos;s prep settings.</div>
        <div className="flex gap-2">
          <button type="button" onClick={save} disabled={!valid || saving}
            className={`inline-flex items-center gap-1.5 ${sheet ? 'h-12' : 'h-10'} px-3.5 rounded-[9px] text-[13px] font-semibold ${valid && !saving ? 'bg-ink text-paper' : 'bg-bg-2 text-ink-3 cursor-not-allowed'}`}>
            <Check size={14} className={valid && !saving ? 'text-gold' : 'text-ink-3'} /> {saving ? 'Saving…' : 'Save par'}
          </button>
          <button type="button" onClick={onClose} className={`${sheet ? 'h-12' : 'h-10'} px-3 rounded-[9px] text-[13px] font-semibold text-ink-2 border border-line`}>Cancel</button>
        </div>
      </div>
    </>
  )
}
