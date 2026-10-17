'use client'
// Recipe Scan — "Create item" (Joshua's decision: name now, price later). Only
// the name and the unit it is counted / bought in: no supplier, pack or price.
// The item is made unpriced; the recipe line links to it and reads "no price
// yet" until its first approved invoice prices it the normal way.
import { useState } from 'react'
import { UOM_GROUPS } from '@/lib/uom'
import type { AmountItem } from '@/lib/recipe-scan/amount'
import { createItemBody, createdItemAmount } from '@/lib/recipe-scan/review'

export interface CreatedItem { id: string; name: string; baseUnit: string; amount: AmountItem; unit: string }

interface Props {
  initialName: string
  initialUnit: string
  revenueCenterId: string | null
  /** 'sheet' = phone bottom sheet buttons (full width, 50px); 'inline' = desktop row. */
  mode: 'sheet' | 'inline'
  onCreated: (item: CreatedItem) => void
  onCancel: () => void
}

export function CreateItemForm({ initialName, initialUnit, revenueCenterId, mode, onCreated, onCancel }: Props) {
  const [name, setName] = useState(initialName)
  const [unit, setUnit] = useState(initialUnit)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const clean = name.trim()
    if (!clean) { setError('Give the item a name.'); return }
    setBusy(true)
    setError(null)
    try {
      const body = createItemBody(clean, unit, revenueCenterId)
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error ?? 'Could not create the item.')
        return
      }
      const amount = createdItemAmount(body)
      onCreated({ id: json.id, name: json.itemName ?? clean, baseUnit: amount.baseUnit, amount, unit: body.countUnit })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the item — check the connection.')
    } finally {
      setBusy(false)
    }
  }

  const sheet = mode === 'sheet'
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-ink-3 leading-snug">
        Name now, price later. The item is added with no price; it gets one from its first approved invoice.
      </p>
      <label className="flex flex-col gap-1">
        <span className="ui-label">Name</span>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus={!sheet}
          className="text-[14px] bg-paper border border-line rounded-[9px] px-3 py-2 outline-none focus:border-ink-3"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="ui-label">Counted / bought in</span>
        <select
          value={unit}
          onChange={e => setUnit(e.target.value)}
          className="text-[14px] font-mono bg-paper border border-line rounded-[9px] px-2.5 py-2 outline-none focus:border-ink-3"
        >
          {UOM_GROUPS.map(g => (
            <optgroup key={g.label} label={g.label}>
              {g.units.map(u => <option key={u.label} value={u.label}>{u.label}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      {error && <p className="text-[12.5px] text-red-text">{error}</p>}
      <div className={sheet ? 'flex flex-col gap-2 mt-1' : 'flex items-center gap-2'}>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className={`${sheet ? 'h-[50px] w-full text-[15px]' : 'h-9 px-4 text-[13px]'} rounded-[12px] font-semibold text-ink bg-gold hover:opacity-90 disabled:opacity-50`}
        >
          {busy ? 'Creating…' : `Create ${name.trim() || 'item'}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className={`${sheet ? 'h-[50px] w-full text-[15px]' : 'h-9 px-4 text-[13px]'} rounded-[12px] font-medium text-ink-2 bg-paper border border-line hover:border-ink-3`}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
