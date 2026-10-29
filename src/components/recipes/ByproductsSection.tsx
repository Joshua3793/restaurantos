'use client'

/**
 * "Comes off this batch" — the by-products box under a PREP recipe's
 * ingredients. A brisket also gives trim and fat: each line is credited at the
 * item's own price and the batch cost the rest of the app reads is
 * ingredients − credits. Every edit saves at once, like an ingredient row,
 * and the server's recomputed recipe replaces the panel's copy.
 */
import { useEffect, useRef, useState } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import { formatCurrency, getUnitConv } from '@/lib/utils'
import { UOM_GROUPS, getUnitGroup } from '@/lib/uom'
import { yieldBreakdown, creditGuardMessage, type ByproductWithCredit } from '@/lib/recipe-byproducts'
import { useUser } from '@/contexts/UserContext'
import { atLeast } from '@/lib/roles'
import type { Recipe } from '@/components/recipes/shared'

interface SearchHit { type: 'inventory' | 'recipe'; id: string; name: string; unit: string; pricePerBaseUnit: number }

/** Units that cost against an item with this base unit (kg/lb/g for a weight item…). */
function unitGroupsFor(baseUnit: string) {
  const group = getUnitGroup(baseUnit)
  return group ? UOM_GROUPS.filter(g => g.label === group) : UOM_GROUPS
}

function UnitSelect({ value, baseUnit, onChange }: { value: string; baseUnit: string; onChange: (u: string) => void }) {
  const groups = unitGroupsFor(baseUnit)
  const known = groups.some(g => g.units.some(u => u.label === value))
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="border border-line rounded px-1 py-0.5 font-mono text-[11px] text-ink-2 bg-paper focus:outline-none focus:ring-1 focus:ring-gold">
      {!known && <option value={value}>{value}</option>}
      {groups.map(g => (
        <optgroup key={g.label} label={g.label}>
          {g.units.map(u => <option key={u.label} value={u.label}>{u.label}</option>)}
        </optgroup>
      ))}
    </select>
  )
}

/** "6 kg" / "800 g" for a gram amount. */
function grams(g: number): string {
  const abs = Math.abs(g)
  return abs >= 1000 ? `${Number((g / 1000).toFixed(2))} kg` : `${Math.round(g)} g`
}

async function readError(res: Response): Promise<string> {
  try { return (await res.json()).error ?? 'Could not save — try again.' } catch { return 'Could not save — try again.' }
}

function ByproductRow({ bp, recipeId, canEdit, onRecipe, onReload }: {
  bp: ByproductWithCredit
  recipeId: string
  canEdit: boolean
  onRecipe: (r: Recipe) => void
  onReload: () => Promise<void>
}) {
  const [qty, setQty] = useState(String(bp.qty))
  const [unit, setUnit] = useState(bp.unit)
  const perUnit = bp.pricePerBaseUnit * getUnitConv(unit)
  const [price, setPrice] = useState(perUnit > 0 ? perUnit.toFixed(2) : '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setQty(String(bp.qty)); setUnit(bp.unit) }, [bp.qty, bp.unit])
  useEffect(() => {
    const p = bp.pricePerBaseUnit * getUnitConv(bp.unit)
    setPrice(p > 0 ? p.toFixed(2) : '')
  }, [bp.pricePerBaseUnit, bp.unit])

  const patch = async (data: Record<string, unknown>) => {
    const res = await fetch(`/api/recipes/${recipeId}/byproducts/${bp.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
    if (!res.ok) { setError(await readError(res)); return }
    setError(null)
    onRecipe(await res.json())
  }

  const saveQty = () => { if (Number(qty) !== bp.qty) patch({ qty: Number(qty), unit }) }
  const saveUnit = (u: string) => { setUnit(u); patch({ qty: Number(qty), unit: u }) }

  // The price IS the item's own price (one number, read by every recipe that
  // uses the item) — so it is edited on the item, not stored on this row.
  const savePrice = async () => {
    const rate = Number(price)
    if (!(rate > 0) || Math.abs(rate - perUnit) < 0.005) return
    const res = await fetch(`/api/inventory/${bp.inventoryItemId}/pricing`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packChain: bp.itemPackChain, pricing: { mode: 'RATE', rate, rateUnit: unit }, expectedLastUpdated: bp.itemLastUpdated }),
    })
    if (!res.ok) setError(await readError(res))
    else setError(null)
    await onReload()
  }

  const remove = async () => {
    const res = await fetch(`/api/recipes/${recipeId}/byproducts/${bp.id}`, { method: 'DELETE' })
    if (!res.ok) { setError(await readError(res)); return }
    onRecipe(await res.json())
  }

  return (
    <div className="border-t border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex-1 min-w-[8rem] text-[13px] text-ink">{bp.itemName}</span>
        <span className="flex items-center gap-1">
          {canEdit ? (
            <input type="number" inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} onBlur={saveQty}
              onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className="w-16 text-right border border-line rounded px-1 py-0.5 font-mono text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-gold" />
          ) : <span className="font-mono text-[13px] text-ink">{bp.qty}</span>}
          {canEdit ? <UnitSelect value={unit} baseUnit={bp.itemBaseUnit} onChange={saveUnit} /> : <span className="font-mono text-[11px] text-ink-3">{bp.unit}</span>}
        </span>
        <span className="flex items-center gap-1 font-mono text-[12px] text-ink-3">
          {canEdit && !bp.hasOffers ? (
            <>
              $<input type="number" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} onBlur={savePrice}
                onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                placeholder={`What would you pay per ${unit}?`}
                className={`${price ? 'w-16' : 'w-44'} text-right border border-line rounded px-1 py-0.5 font-mono text-[12px] text-ink focus:outline-none focus:ring-1 focus:ring-gold`} />
              /{unit}
            </>
          ) : (
            <span>{perUnit > 0 ? `${formatCurrency(perUnit)}/${unit}` : 'No price yet'}{bp.hasOffers && bp.primarySupplierName ? ` · ${bp.primarySupplierName}` : ''}</span>
          )}
        </span>
        {/* Credit and remove stay together, so the bin never wraps onto its own line. */}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="text-right font-mono text-[13px] font-medium text-green-text">
            {bp.dimensionConflict
              ? <span className="rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-red-text bg-red-soft" title={`${bp.unit} can't be costed against ${bp.itemName} (${bp.itemBaseUnit}) — credited at $0`}>unit mismatch</span>
              : `− ${formatCurrency(bp.credit)}`}
          </span>
          {canEdit && (
            <button onClick={remove} title="Remove" className="text-ink-4 hover:text-red"><Trash2 size={12} /></button>
          )}
        </span>
      </div>
      {error && <p className="mt-1 text-[11.5px] text-red-text">{error}</p>}
    </div>
  )
}

function AddByproduct({ recipe, onRecipe, onCancel }: { recipe: Recipe; onRecipe: (r: Recipe) => void; onCancel: () => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [picked, setPicked] = useState<{ id: string | null; name: string; baseUnit: string } | null>(null)
  const [qty, setQty] = useState('')
  const [unit, setUnit] = useState(recipe.yieldUnit)
  const [rate, setRate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  const search = (text: string) => {
    setQ(text)
    clearTimeout(timer.current)
    if (!text.trim()) { setHits([]); return }
    timer.current = setTimeout(async () => {
      const data: SearchHit[] = await fetch(`/api/recipes/search-ingredients?q=${encodeURIComponent(text)}`).then(r => r.json())
      // Only plain items can come off a batch — never another recipe's output.
      setHits(data.filter(h => h.type === 'inventory'))
    }, 300)
  }

  const pick = (p: { id: string | null; name: string; baseUnit: string }) => {
    setPicked(p); setHits([]); setError(null)
    // The recipe's yield unit when it fits the item (kg trim off a kg brisket), else the item's own.
    const fits = getUnitGroup(recipe.yieldUnit) === getUnitGroup(p.baseUnit)
    setUnit(fits ? recipe.yieldUnit : p.baseUnit)
  }

  const add = async () => {
    if (!picked) return
    setSaving(true)
    const body = picked.id
      ? { inventoryItemId: picked.id, qty: Number(qty), unit }
      : { createItem: { itemName: picked.name, rate: Number(rate) }, qty: Number(qty), unit }
    const res = await fetch(`/api/recipes/${recipe.id}/byproducts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    setSaving(false)
    if (!res.ok) { setError(await readError(res)); return }
    onRecipe(await res.json())
    onCancel()
  }

  return (
    <div className="border-t border-line px-3 py-2.5 space-y-2">
      {!picked ? (
        <div className="relative">
          <div className="flex items-center gap-2 border border-line rounded-lg px-2 py-1.5 bg-paper">
            <Search size={13} className="text-ink-4 shrink-0" />
            <input autoFocus value={q} onChange={e => search(e.target.value)} onKeyDown={e => e.key === 'Escape' && onCancel()}
              placeholder="Fat, trim, bones…" className="flex-1 text-[13px] bg-transparent focus:outline-none" />
            <button onClick={onCancel} className="text-[11px] text-ink-4 hover:text-ink-2">Cancel</button>
          </div>
          {(hits.length > 0 || q.trim()) && (
            <div className="mt-1 border border-line rounded-lg bg-paper overflow-hidden">
              {hits.map(h => (
                <button key={h.id} onClick={() => pick({ id: h.id, name: h.name, baseUnit: h.unit })}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-left text-[13px] hover:bg-bg">
                  <span className="text-ink">{h.name}</span>
                  <span className="font-mono text-[11px] text-ink-4">{h.pricePerBaseUnit > 0 ? `${formatCurrency(h.pricePerBaseUnit * getUnitConv(recipe.yieldUnit))}/${recipe.yieldUnit}` : 'no price'}</span>
                </button>
              ))}
              {q.trim() && !hits.some(h => h.name.toLowerCase() === q.trim().toLowerCase()) && (
                <button onClick={() => pick({ id: null, name: q.trim(), baseUnit: recipe.yieldUnit })}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-bg border-t border-line">
                  <Plus size={12} className="text-gold-2" />
                  <span className="text-ink-2">Create <span className="font-medium text-ink">&ldquo;{q.trim()}&rdquo;</span></span>
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1 min-w-[8rem] text-[13px] text-ink">{picked.name}{!picked.id && <span className="ml-1.5 text-[11px] text-ink-4">new item</span>}</span>
          <input autoFocus type="number" inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} placeholder="How much"
            className="w-20 text-right border border-line rounded px-1 py-0.5 font-mono text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-gold" />
          <UnitSelect value={unit} baseUnit={picked.baseUnit} onChange={setUnit} />
          {!picked.id && (
            <span className="flex items-center gap-1 font-mono text-[12px] text-ink-3">
              $<input type="number" inputMode="decimal" value={rate} onChange={e => setRate(e.target.value)} placeholder={`What would you pay per ${unit}?`}
                className="w-44 text-right border border-line rounded px-1 py-0.5 font-mono text-[12px] text-ink focus:outline-none focus:ring-1 focus:ring-gold" />
            </span>
          )}
          <button onClick={add} disabled={saving || !(Number(qty) > 0) || (!picked.id && !(Number(rate) > 0))}
            className="px-2.5 py-1 rounded-md bg-ink text-paper text-[12px] font-medium disabled:opacity-40">Add</button>
          <button onClick={onCancel} className="text-[11px] text-ink-4 hover:text-ink-2">Cancel</button>
        </div>
      )}
      {error && <p className="text-[11.5px] text-red-text">{error}</p>}
    </div>
  )
}

const PART_COLOURS = ['bg-gold', 'bg-green', 'bg-blue-text', 'bg-red']

function YieldBar({ recipe }: { recipe: Recipe }) {
  const b = yieldBreakdown({
    ingredients: recipe.ingredients,
    baseYieldQty: recipe.baseYieldQty,
    yieldUnit: recipe.yieldUnit,
    byproducts: recipe.byproducts ?? [],
  })
  if (!b) return null
  const total = Math.max(b.input, b.main + b.parts.reduce((s, p) => s + p.qty, 0)) || 1
  const pct = (g: number) => `${Math.max(0, (g / total) * 100)}%`
  return (
    <div className="px-3 py-2.5 border-t border-line space-y-1.5">
      <div className="text-[11px] text-ink-3">Where the {grams(b.input)} went</div>
      <div className={`flex h-2.5 rounded-full overflow-hidden ${b.overflow ? 'ring-2 ring-red' : 'bg-bg-2'}`}>
        <div className="bg-ink" style={{ width: pct(b.main) }} />
        {b.parts.map((p, i) => <div key={i} className={PART_COLOURS[i % PART_COLOURS.length]} style={{ width: pct(p.qty) }} />)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-3">
        <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-ink" />{recipe.name} {grams(b.main)}</span>
        {b.parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1"><i className={`w-2 h-2 rounded-full ${PART_COLOURS[i % PART_COLOURS.length]}`} />{p.name} {grams(p.qty)}</span>
        ))}
        {b.lost > 0 && <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-bg-2 border border-line-2" />Lost {grams(b.lost)}</span>}
      </div>
      {b.overflow && <p className="text-[11.5px] text-red-text">More comes out than goes in — check the weights.</p>}
    </div>
  )
}

export function ByproductsSection({ recipe, onRecipe, onReload }: {
  recipe: Recipe
  /** Replace the panel's recipe with the server's recomputed one. */
  onRecipe: (r: Recipe) => void
  /** Re-read the recipe (after an item price edit, which answers with the item). */
  onReload: () => Promise<void>
}) {
  const { role } = useUser()
  const canEdit = role !== null && atLeast(role, 'MANAGER')
  const [adding, setAdding] = useState(false)
  if (recipe.type !== 'PREP') return null

  const rows = recipe.byproducts ?? []
  const credit = recipe.byproductCredit ?? 0
  const gross = recipe.grossCost ?? recipe.totalCost

  if (rows.length === 0 && !adding) {
    if (!canEdit) return null
    return (
      <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink">
        <Plus size={12} /> Something else comes off this batch (fat, trim, bones…)
      </button>
    )
  }

  return (
    <div className="border border-line rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-bg text-xs font-medium text-ink-3">
        <span className="uppercase tracking-[0.06em]">Comes off this batch</span>
        {credit > 0 && <span className="font-mono text-[13px] text-green-text">− {formatCurrency(credit)}</span>}
      </div>
      {rows.map(bp => (
        <ByproductRow key={bp.id} bp={bp} recipeId={recipe.id} canEdit={canEdit} onRecipe={onRecipe} onReload={onReload} />
      ))}
      {adding
        ? <AddByproduct recipe={recipe} onRecipe={onRecipe} onCancel={() => setAdding(false)} />
        : canEdit && (
          <button onClick={() => setAdding(true)} className="w-full flex items-center gap-1.5 border-t border-line px-3 py-2 text-[12px] text-ink-3 hover:text-ink hover:bg-bg/60">
            <Plus size={12} /> Add a by-product
          </button>
        )}
      <YieldBar recipe={recipe} />
      {rows.length > 0 && (
        <div className="px-3 py-2 border-t border-line bg-bg text-[12px] text-ink-2 font-mono">
          Ingredients {formatCurrency(gross)} − credits {formatCurrency(credit)} = {formatCurrency(recipe.totalCost)}
          {recipe.baseYieldQty > 0 && <> · {formatCurrency(recipe.totalCost / recipe.baseYieldQty)}/{recipe.yieldUnit}</>}
        </div>
      )}
      {recipe.creditExceedsCost && (
        <p className="px-3 py-2 border-t border-line text-[12px] text-red-text bg-red-soft">{creditGuardMessage(credit, gross)}</p>
      )}
    </div>
  )
}
