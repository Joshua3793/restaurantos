'use client'
import { useState } from 'react'
import { X } from 'lucide-react'
import { ALLERGENS, ALLERGEN_MAP } from '@/lib/allergens'

interface BadgeProps {
  allergens: string[]
  size?: 'xs' | 'sm'
}

export function AllergenBadges({ allergens, size = 'xs' }: BadgeProps) {
  if (!allergens || allergens.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {allergens.map(key => {
        const def = ALLERGEN_MAP[key]
        if (!def) return null
        return (
          <span
            key={key}
            title={def.label}
            style={{ backgroundColor: def.hex, color: def.dark ? '#fff' : '#111' }}
            className={`inline-flex items-center rounded font-bold leading-none ${
              size === 'xs'
                ? 'px-1 py-0.5 text-[9px] tracking-wide'
                : 'px-1.5 py-1 text-[11px] tracking-wide'
            }`}
          >
            {def.abbr}
          </span>
        )
      })}
    </div>
  )
}

interface BulkAllergenModalProps {
  count: number
  onClose: () => void
  onApply: (allergens: string[], mode: 'add' | 'replace') => void
}

export function BulkAllergenModal({ count, onClose, onApply }: BulkAllergenModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = (key: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">Assign Allergens</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-5">
          {ALLERGENS.map(a => {
            const on = selected.has(a.key)
            return (
              <button
                key={a.key}
                onClick={() => toggle(a.key)}
                style={on ? { backgroundColor: a.hex, borderColor: a.hex } : undefined}
                className={`flex flex-col items-center gap-1 p-2 rounded-xl border-2 transition-all ${
                  on ? '' : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}
              >
                <span style={on ? { color: a.dark ? '#fff' : '#111' } : undefined}
                  className={`text-[10px] font-bold tracking-wide ${on ? '' : 'text-gray-500'}`}>
                  {a.abbr}
                </span>
                <span style={on ? { color: a.dark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.6)' } : undefined}
                  className={`text-[9px] leading-tight text-center ${on ? '' : 'text-gray-400'}`}>
                  {a.label}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onApply(Array.from(selected), 'add')}
            disabled={selected.size === 0}
            className="flex-1 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add to {count} items
          </button>
          <button onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
