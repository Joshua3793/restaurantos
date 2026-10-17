'use client'
// Recipe Scan — the review page head (design: ScanReviewHead). Crumbs say where
// the recipe came from, the name is the page title (editable in place), the
// lede says how much is left to do, then yield, category, Discard and Save.
// Save stays disabled while anything blocks it, and the list of what blocks it
// sits right under the button.
import Link from 'next/link'
import { useState } from 'react'
import { PREP_YIELD_UNITS, canonicalUom } from '@/lib/uom'
import { Pill } from '@/components/ui/Pill'

export interface CategoryOption { id: string; name: string; color: string | null }

interface Props {
  crumb: string
  name: string
  onName: (name: string) => void
  ingredients: number
  steps: number
  needYou: number
  categories: CategoryOption[]
  categoryId: string | null
  onCategory: (id: string) => void
  yieldQty: number | null
  yieldUnit: string | null
  yieldGuessed: boolean
  onYield: (qty: number | null, unit: string | null) => void
  blockers: string[]
  saving: boolean
  onSave: () => void
  onDiscard: () => Promise<void>
  /** "Saved" / "Saving…" — the autosave state, quiet. */
  autosave: string
  error: string | null
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function CategoryPill({ categories, categoryId, onCategory }: Pick<Props, 'categories' | 'categoryId' | 'onCategory'>) {
  const cat = categories.find(c => c.id === categoryId) ?? null
  return (
    <label
      className={`relative inline-flex items-center gap-[6px] whitespace-nowrap font-mono text-[10px] font-medium uppercase px-[10px] py-[5px] rounded-full cursor-pointer ${
        cat ? 'bg-bg-2 text-ink-2 hover:bg-line' : 'bg-gold-soft text-gold-2'
      }`}
      title="Change category"
    >
      {cat && <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: cat.color ?? '#94a3b8' }} />}
      {cat ? `Prep · ${cat.name}` : 'Pick a category'}
      <span className="text-ink-4">▾</span>
      <select
        aria-label="Category"
        value={categoryId ?? ''}
        onChange={e => { if (e.target.value) onCategory(e.target.value) }}
        className="absolute inset-0 opacity-0 cursor-pointer w-full"
      >
        <option value="" disabled>Pick a category</option>
        {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  )
}

function YieldField({ yieldQty, yieldUnit, yieldGuessed, onYield }: Pick<Props, 'yieldQty' | 'yieldUnit' | 'yieldGuessed' | 'onYield'>) {
  const canon = canonicalUom(yieldUnit ?? '')
  const known = (PREP_YIELD_UNITS as readonly string[]).includes(canon)
  const unitValue = known ? canon : (yieldUnit ?? '')
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3">Yield</span>
      <input
        key={`q-${yieldQty ?? ''}`}
        type="number" min={0} step="any" inputMode="decimal"
        defaultValue={yieldQty ?? ''}
        placeholder="qty"
        aria-label="Yield quantity"
        onBlur={e => {
          const v = e.target.value.trim()
          const n = v === '' ? null : Number(v)
          const next = n !== null && Number.isFinite(n) && n > 0 ? n : null
          if (next !== yieldQty) onYield(next, yieldUnit)
        }}
        className={`w-[76px] font-mono text-[13px] text-right bg-paper border rounded-[7px] px-2 py-1 outline-none focus:border-ink-3 ${
          yieldQty === null ? 'border-gold' : 'border-line'
        }`}
      />
      <select
        aria-label="Yield unit"
        value={unitValue}
        onChange={e => onYield(yieldQty, e.target.value || null)}
        className={`font-mono text-[12.5px] bg-paper border rounded-[7px] px-1.5 py-1 outline-none focus:border-ink-3 ${
          unitValue ? 'border-line' : 'border-gold'
        }`}
      >
        <option value="" disabled>unit</option>
        {!known && yieldUnit && <option value={yieldUnit}>{yieldUnit}</option>}
        {PREP_YIELD_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
      </select>
      {yieldGuessed && <Pill tone="gold">Check</Pill>}
      {yieldGuessed && <span className="ui-meta">the page gave no yield</span>}
    </div>
  )
}

export function ReviewHead(p: Props) {
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const disabled = p.blockers.length > 0 || p.saving

  return (
    <header className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 md:gap-8">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.04em] uppercase mb-2 truncate">
          <Link href="/recipes" className="hover:text-ink">Recipes</Link> · Scan · {p.crumb}
        </div>
        <input
          value={p.name}
          onChange={e => p.onName(e.target.value)}
          placeholder="Recipe name"
          aria-label="Recipe name"
          className="w-full bg-transparent text-[28px] md:text-[36px] font-semibold tracking-[-0.04em] leading-[1.1] text-ink outline-none border-b border-transparent hover:border-line focus:border-ink-3 placeholder:text-ink-4"
        />
        <p className="text-[15px] text-ink-3 mt-2 leading-snug">
          Read <b className="text-ink font-semibold">{plural(p.ingredients, 'ingredient', 'ingredients')}</b> and{' '}
          <b className="text-ink font-semibold">{plural(p.steps, 'step', 'steps')}</b>.{' '}
          {p.needYou > 0 ? (
            <><b className="text-red-text font-semibold">{p.needYou} need you</b> before it can be costed.</>
          ) : (
            <b className="text-green-text font-semibold">Every line is sorted.</b>
          )}
        </p>
        <div className="mt-3">
          <YieldField yieldQty={p.yieldQty} yieldUnit={p.yieldUnit} yieldGuessed={p.yieldGuessed} onYield={p.onYield} />
        </div>
      </div>

      <div className="flex flex-col items-stretch md:items-end gap-2 md:max-w-[480px] shrink-0">
        <div className="flex items-center gap-2 flex-wrap md:flex-nowrap md:justify-end">
          <CategoryPill categories={p.categories} categoryId={p.categoryId} onCategory={p.onCategory} />
          <span className="flex-1 md:hidden" />
          {confirmDiscard ? (
            <>
              <button
                type="button"
                disabled={discarding}
                onClick={async () => { setDiscarding(true); await p.onDiscard(); setDiscarding(false); setConfirmDiscard(false) }}
                className="whitespace-nowrap px-3 py-2 rounded-[9px] text-[13px] font-medium text-paper bg-red hover:opacity-90 disabled:opacity-50"
              >
                {discarding ? 'Discarding…' : 'Discard recipe'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDiscard(false)}
                className="px-3 py-2 rounded-[9px] text-[13px] font-medium text-ink-2 bg-paper border border-line hover:border-ink-3"
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDiscard(true)}
              className="px-3.5 py-2 rounded-[9px] text-[13px] font-medium text-ink-2 bg-paper border border-line hover:border-ink-3"
            >
              Discard
            </button>
          )}
          <button
            type="button"
            onClick={p.onSave}
            disabled={disabled}
            className="whitespace-nowrap w-full md:w-auto justify-center flex items-center gap-1.5 px-4 py-2.5 md:py-2 rounded-[9px] text-[13px] font-medium text-paper bg-ink hover:bg-ink-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="text-gold font-semibold">→</span>
            {p.saving ? 'Saving…' : 'Save recipe'}
          </button>
        </div>
        {p.error && <p className="text-[12.5px] text-red-text md:text-right">{p.error}</p>}
        {p.blockers.length > 0 && (
          <ul className="flex flex-col gap-0.5 md:items-end">
            {p.blockers.map(b => (
              <li key={b} className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                <span className="w-[5px] h-[5px] rounded-full bg-red shrink-0" />
                {b}
              </li>
            ))}
          </ul>
        )}
        <span className="ui-meta md:text-right">{p.autosave}</span>
      </div>
    </header>
  )
}
