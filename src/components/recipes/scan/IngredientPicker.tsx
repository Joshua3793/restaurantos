'use client'
// Recipe Scan — pick what a scanned line is (design: FuzzyPicker). A bottom
// sheet on the phone, an expanded row on the desktop. The closest inventory
// items and prep recipes, best guess first and pre-selected, each with one
// mono line that tells look-alikes apart (how it's bought · main supplier ·
// how many recipes use it) and a bar for how close it is. Then "Use …",
// "Create item" and "Keep uncosted".
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import { similarity } from '@/lib/recipe-match'
import { useDrawer } from '@/contexts/DrawerContext'
import type { DraftLine } from '@/lib/recipe-scan/types'
import { defaultCreateUnit, type PickCandidate } from '@/lib/recipe-scan/review'
import { CreateItemForm, type CreatedItem } from './CreateItemForm'

interface Props {
  line: DraftLine
  mode: 'sheet' | 'inline'
  revenueCenterId: string | null
  /** The line's pill, shown at the top of the phone sheet. */
  pill: ReactNode
  onPick: (c: PickCandidate) => void
  onCreated: (item: CreatedItem) => void
  onKeep: () => void
  onClose: () => void
}

const SEARCH_DEBOUNCE_MS = 250

function titleCase(s: string): string {
  return s.trim().replace(/\s+/g, ' ').replace(/(^|\s)(\p{L})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase())
}

function optionMeta(c: PickCandidate): string {
  const parts = [c.boughtAs]
  if (c.supplier) parts.push(c.supplier)
  parts.push(`${c.usedInRecipes} ${c.usedInRecipes === 1 ? 'recipe' : 'recipes'}`)
  return parts.filter(Boolean).join(' · ').toUpperCase()
}

function OptionRow({ c, on, best, closeness, onSelect, onUse }: {
  c: PickCandidate
  on: boolean
  best: boolean
  closeness: number
  onSelect: () => void
  onUse: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onUse}
      className={`w-full grid grid-cols-[22px_minmax(0,1fr)_52px] gap-3 items-center px-3.5 py-3 border-b border-line last:border-b-0 text-left transition-colors ${on ? 'bg-bg' : 'hover:bg-bg'}`}
      aria-pressed={on}
    >
      <span className={`relative w-5 h-5 rounded-full border-[1.5px] ${on ? 'border-ink' : 'border-line-2'}`}>
        {on && <span className="absolute inset-[4px] rounded-full bg-ink" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold tracking-[-0.01em] text-ink truncate">{c.name}</span>
        <span className="block font-mono text-[10.5px] text-ink-3 mt-[3px] truncate">{optionMeta(c)}</span>
      </span>
      <span className="h-[6px] rounded-full bg-bg-2 overflow-hidden" aria-hidden>
        <span className="block h-full rounded-full" style={{ width: `${Math.max(8, Math.round(closeness * 100))}%`, background: best ? '#09090b' : '#71717a' }} />
      </span>
    </button>
  )
}

export function IngredientPicker({ line, mode, revenueCenterId, pill, onPick, onCreated, onKeep, onClose }: Props) {
  const [q, setQ] = useState(line.name || line.raw)
  const [results, setResults] = useState<PickCandidate[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<'pick' | 'create'>('pick')
  const seq = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/recipe-scans/candidates?q=${encodeURIComponent(q.trim())}`, { cache: 'no-store' })
        const json = await res.json().catch(() => null)
        if (mine !== seq.current) return
        if (!res.ok || !Array.isArray(json)) {
          setError(json?.error ?? 'Could not load the list.')
          setResults([])
        } else {
          setError(null)
          setResults(json as PickCandidate[])
          // Best guess first and pre-selected — unless the chef already chose one that is still listed.
          setSelected(prev => (prev && (json as PickCandidate[]).some(c => `${c.kind}:${c.id}` === prev)
            ? prev
            : json[0] ? `${json[0].kind}:${json[0].id}` : null))
        }
      } catch {
        if (mine === seq.current) { setError('Could not load the list — check the connection.'); setResults([]) }
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q])

  // Lock the page behind the phone sheet, and hide the floating chat button over it.
  const { setDrawerOpen } = useDrawer()
  useEffect(() => {
    if (mode !== 'sheet') return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    setDrawerOpen(true)
    return () => { document.body.style.overflow = prev; setDrawerOpen(false) }
  }, [mode, setDrawerOpen])

  const closeness = useMemo(() => {
    const m = new Map<string, number>()
    // Closeness to what the chef is searching for (the scanned name to start with).
    const against = q.trim() || line.name || line.raw
    for (const c of results ?? []) m.set(`${c.kind}:${c.id}`, similarity(against, c.name))
    return m
  }, [results, q, line.name, line.raw])

  const chosen = (results ?? []).find(c => `${c.kind}:${c.id}` === selected) ?? null
  const sheet = mode === 'sheet'

  const search = (
    <div className="relative">
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search items and prep recipes"
        aria-label="Search items and prep recipes"
        className="w-full text-[14px] bg-paper border border-line rounded-[9px] pl-8 pr-8 py-2 outline-none focus:border-ink-3"
      />
      {loading && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 animate-spin" />}
    </div>
  )

  const list = (
    <div className={`bg-paper border border-line rounded-lg overflow-y-auto ${sheet ? 'max-h-[38vh]' : 'max-h-[300px]'}`}>
      {results === null ? (
        <p className="px-3.5 py-4 ui-meta">Looking…</p>
      ) : results.length === 0 ? (
        <p className="px-3.5 py-4 text-[13px] text-ink-3">{error ?? 'Nothing close. Create the item, or keep the line uncosted.'}</p>
      ) : (
        results.map((c, i) => (
          <OptionRow
            key={`${c.kind}:${c.id}`}
            c={c}
            on={selected === `${c.kind}:${c.id}`}
            best={i === 0}
            closeness={closeness.get(`${c.kind}:${c.id}`) ?? 0}
            onSelect={() => setSelected(`${c.kind}:${c.id}`)}
            onUse={() => onPick(c)}
          />
        ))
      )}
    </div>
  )

  const btn = sheet
    ? 'h-[50px] w-full rounded-[12px] text-[15px] font-semibold'
    : 'h-9 px-4 rounded-[9px] text-[13px] font-medium'

  const actions = (
    <div className={sheet ? 'grid grid-cols-2 gap-2' : 'flex items-center gap-2 flex-wrap'}>
      <button
        type="button"
        disabled={!chosen}
        onClick={() => chosen && onPick(chosen)}
        className={`${btn} ${sheet ? 'col-span-2' : ''} bg-gold text-ink hover:opacity-90 disabled:opacity-40 truncate`}
      >
        {chosen ? `Use ${chosen.name}` : 'Pick an item'}
      </button>
      <button type="button" onClick={() => setView('create')} className={`${btn} bg-paper border border-line text-ink-2 hover:border-ink-3`}>
        Create item
      </button>
      <button type="button" onClick={onKeep} className={`${btn} bg-paper border border-line text-ink-2 hover:border-ink-3`}>
        Keep uncosted
      </button>
      {!sheet && (
        <button type="button" onClick={onClose} className="ml-auto text-[12.5px] text-ink-3 hover:text-ink">Close</button>
      )}
    </div>
  )

  const body = view === 'create' ? (
    <CreateItemForm
      initialName={titleCase(line.name || line.raw)}
      initialUnit={defaultCreateUnit(line.qtyText)}
      revenueCenterId={revenueCenterId}
      mode={mode}
      onCreated={onCreated}
      onCancel={() => setView('pick')}
    />
  ) : (
    <>
      {search}
      {list}
      {actions}
    </>
  )

  if (!sheet) {
    return (
      <div className="mx-3 md:ml-[52px] md:mr-4 mb-4 p-3 rounded-lg bg-bg border border-line flex flex-col gap-3">
        {view === 'create' && <div className="text-[13.5px] font-semibold text-ink">Create item</div>}
        {body}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end">
      <div className="absolute inset-0" style={{ background: 'rgba(9,9,11,.45)' }} onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Pick an item for ${line.raw}`}
        className="relative bg-paper w-full rounded-t-[22px] px-[18px] pt-2.5 pb-6 flex flex-col gap-3.5 max-h-[92vh] overflow-y-auto pb-safe"
      >
        <div className="w-[38px] h-[5px] rounded-full bg-line-2 mx-auto mb-1 shrink-0" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {pill}
            <h2 className="text-[20px] font-semibold tracking-[-0.03em] leading-tight text-ink mt-2">
              {view === 'create' ? 'Create item' : line.raw}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 -mr-1 text-ink-3 hover:text-ink">
            <X size={18} />
          </button>
        </div>
        {body}
      </div>
    </div>
  )
}
