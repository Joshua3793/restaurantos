'use client'
// Smart Prep — the collapsed "Not prepped" group under the suggestions: items a
// chef switched off the prep list (feature / special recipes). The recipe is
// untouched; open one and use the drawer's "Prepped on the line" switch to put
// it back into the suggestions.
import { useState } from 'react'
import { EyeOff, ChevronDown, ChevronUp } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import { PrepRow } from './PrepRow'

const noop = () => {}
const noFix = async () => false

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
        className="flex items-center gap-2 min-h-[44px] mx-0.5 text-[13px] font-semibold text-ink-3 hover:text-ink-2">
        <EyeOff size={14} /> Not prepped · {hidden.length}
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <>
          <p className="mx-0.5 mb-2 text-[12.5px] leading-snug text-ink-3">
            Recipes kept off the prep list. The recipe itself is untouched — open one and switch it back on to see it in the suggestions.
          </p>
          <div className="flex flex-col border-b border-line">
            {[...hidden].sort((a, b) => a.name.localeCompare(b.name)).map(t => (
              <PrepRow key={t.id} item={t} kind="ATPAR" ctx={null} nowMin={0} locked={locked} canFixPar={false}
                onOpen={onOpen} onAdd={noop} onRemove={noop} onFixPar={noFix} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
