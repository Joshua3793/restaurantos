'use client'
// Recipe Scan — allergens on a line that is not linked to an item. A linked
// line carries its item's allergens; an unlinked one only has what the chef
// ticks here, so the choice is required before the recipe can be saved:
// the Health Canada list as tick chips, or "No allergens".
import { Check } from 'lucide-react'
import { ALLERGENS } from '@/lib/allergens'

interface Props {
  /** null = not chosen yet; [] = "No allergens". */
  value: string[] | null
  onChange: (next: string[] | null) => void
}

const CHIP = 'inline-flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] px-2 py-[3px] rounded-full border transition-colors'

export function AllergenChoice({ value, onChange }: Props) {
  const active = new Set(value ?? [])
  const none = value !== null && value.length === 0

  const toggle = (key: string) => {
    const next = new Set(active)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    const list = ALLERGENS.map(a => a.key).filter(k => next.has(k))
    // Unticking the last allergen goes back to "not chosen" — never a silent "none".
    onChange(list.length ? list : null)
  }

  return (
    <div>
      <p className={`text-[12px] mb-1.5 ${value === null ? 'text-red-text' : 'text-ink-3'}`}>
        {value === null
          ? 'Not costed — tick its allergens, or No allergens, before saving.'
          : 'Not costed · allergens on this line:'}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Allergens on this line">
        {ALLERGENS.map(a => {
          const on = active.has(a.key)
          return (
            <button
              key={a.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(a.key)}
              style={on ? { borderColor: a.hex, backgroundColor: `${a.hex}18`, color: a.hex } : undefined}
              className={`${CHIP} ${on ? '' : 'border-line bg-bg-2 text-ink-2 hover:border-line-2'}`}
            >
              {on && <Check size={9} strokeWidth={3} />}
              {a.label}
            </button>
          )
        })}
        <button
          type="button"
          aria-pressed={none}
          onClick={() => onChange(none ? null : [])}
          className={`${CHIP} ${none ? 'border-ink bg-ink text-paper' : 'border-line bg-paper text-ink-2 hover:border-line-2'}`}
        >
          {none && <Check size={9} strokeWidth={3} />}
          No allergens
        </button>
      </div>
    </div>
  )
}
