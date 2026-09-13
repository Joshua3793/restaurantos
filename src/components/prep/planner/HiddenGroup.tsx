'use client'
// Smart Prep — the collapsed "Not prepped" group under the suggestions: items a
// chef switched off the prep list (feature / special recipes). The recipe is
// untouched; open one and use the drawer's "Prepped on the line" switch to put
// it back into the suggestions.
import { useState } from 'react'
import { EyeOff, ChevronDown, ChevronUp } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import { SuggestionRow } from './SuggestionRow'

const noop = () => {}

export function HiddenGroup({ hidden, locked, onOpen }: {
  hidden: PrepItemRich[]
  locked: boolean
  onOpen: (item: PrepItemRich) => void
}) {
  const [open, setOpen] = useState(false)
  if (!hidden.length) return null
  return (
    <div className="mt-4">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 mx-0.5 mb-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] text-ink-4 hover:text-ink-2">
        <EyeOff size={11} /> Not prepped · {hidden.length}
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>
      {open && (
        <>
          <p className="mx-0.5 mb-2 text-[11px] leading-snug text-ink-4">
            Recipes kept off the prep list. The recipe itself is untouched — open one and switch it back on to see it in the suggestions.
          </p>
          <div className="flex flex-col gap-1.5">
            {[...hidden].sort((a, b) => a.name.localeCompare(b.name)).map(t => (
              <SuggestionRow key={t.id} item={t} locked={locked} onOpen={onOpen} onAdd={noop} onRemove={noop} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
