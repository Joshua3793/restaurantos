'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Package, BookOpen, FileText, Truck, X, ArrowRight, UtensilsCrossed } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string
  href: string
  icon: React.ReactNode
  title: string
  subtitle: string
  badge?: { label: string; color: string }
}

interface RawResults {
  inventory: Array<{ id: string; itemName: string; category: string; stockOnHand: number; baseUnit: string; pricePerBaseUnit: number }>
  recipes: Array<{ id: string; name: string; type: string; menuPrice: number | null; totalCost: number; category: { name: string } | null }>
  invoices: Array<{ id: string; invoiceNumber: string; status: string; invoiceDate: string; totalAmount: number; supplier: { name: string } }>
  suppliers: Array<{ id: string; name: string }>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  COMPLETE: 'bg-green-100 text-green-700',
  PROCESSING: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-amber-100 text-amber-700',
}

function buildResults(raw: RawResults): { group: string; items: SearchResult[] }[] {
  const groups: { group: string; items: SearchResult[] }[] = []

  if (raw.inventory.length > 0) {
    groups.push({
      group: 'Inventory',
      items: raw.inventory.map(i => ({
        id: i.id,
        href: `/inventory?search=${encodeURIComponent(i.itemName)}`,
        icon: <Package size={14} className="text-blue-500 shrink-0" />,
        title: i.itemName,
        subtitle: `${i.category} · ${parseFloat(String(i.stockOnHand)).toFixed(1)} ${i.baseUnit} on hand · ${formatCurrency(parseFloat(String(i.pricePerBaseUnit)))}/${i.baseUnit}`,
      })),
    })
  }

  if (raw.recipes.length > 0) {
    groups.push({
      group: 'Recipes',
      items: raw.recipes.map(r => {
        const isMenu = r.type === 'MENU'
        const cost = parseFloat(String(r.totalCost))
        const price = r.menuPrice ? parseFloat(String(r.menuPrice)) : null
        const pct = price ? (cost / price) * 100 : null
        return {
          id: r.id,
          href: isMenu ? `/menu` : `/recipes`,
          icon: isMenu
            ? <UtensilsCrossed size={14} className="text-purple-500 shrink-0" />
            : <BookOpen size={14} className="text-emerald-600 shrink-0" />,
          title: r.name,
          subtitle: `${r.category?.name ?? ''} · ${formatCurrency(cost)} total cost${pct !== null ? ` · ${pct.toFixed(1)}% food cost` : ''}`,
          badge: isMenu
            ? { label: 'Menu', color: 'bg-purple-50 text-purple-600' }
            : { label: 'Prep', color: 'bg-emerald-50 text-emerald-600' },
        }
      }),
    })
  }

  if (raw.invoices.length > 0) {
    groups.push({
      group: 'Invoices',
      items: raw.invoices.map(inv => ({
        id: inv.id,
        href: `/invoices`,
        icon: <FileText size={14} className="text-gray-500 shrink-0" />,
        title: inv.invoiceNumber || '(No number)',
        subtitle: `${inv.supplier.name} · ${new Date(inv.invoiceDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })} · ${formatCurrency(parseFloat(String(inv.totalAmount)))}`,
        badge: { label: inv.status, color: STATUS_COLORS[inv.status] ?? 'bg-gray-100 text-gray-500' },
      })),
    })
  }

  if (raw.suppliers.length > 0) {
    groups.push({
      group: 'Suppliers',
      items: raw.suppliers.map(s => ({
        id: s.id,
        href: `/inventory/suppliers`,
        icon: <Truck size={14} className="text-gray-400 shrink-0" />,
        title: s.name,
        subtitle: 'Supplier',
      })),
    })
  }

  return groups
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GlobalSearch() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<{ group: string; items: SearchResult[] }[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Flatten all items for keyboard navigation
  const allItems = groups.flatMap(g => g.items)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setGroups([])
    setSelectedIdx(0)
  }, [])

  const navigate = useCallback((href: string) => {
    close()
    router.push(href)
  }, [close, router])

  // Cmd+K / Ctrl+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.length < 2) { setGroups([]); setLoading(false); return }
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
        const raw: RawResults = await res.json()
        setGroups(buildResults(raw))
        setSelectedIdx(0)
      } finally {
        setLoading(false)
      }
    }, 220)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query])

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(i => Math.min(i + 1, allItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && allItems[selectedIdx]) {
      navigate(allItems[selectedIdx].href)
    }
  }

  if (!open) return null

  const isEmpty = query.length >= 2 && !loading && groups.length === 0

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] px-4"
      onMouseDown={e => { if (e.target === e.currentTarget) close() }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />

      {/* Panel */}
      <div className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]">

        {/* Input row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <Search size={17} className="text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search inventory, recipes, invoices, suppliers…"
            className="flex-1 text-sm text-gray-900 placeholder-gray-400 outline-none bg-transparent"
          />
          {loading && (
            <div className="w-3.5 h-3.5 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin shrink-0" />
          )}
          {query && !loading && (
            <button onClick={() => { setQuery(''); setGroups([]); inputRef.current?.focus() }}
              className="text-gray-300 hover:text-gray-500 shrink-0">
              <X size={15} />
            </button>
          )}
          <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded font-mono shrink-0">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div className="overflow-y-auto flex-1">
          {query.length < 2 && (
            <div className="px-4 py-10 text-center text-sm text-gray-400">
              Type to search across inventory, recipes, invoices and suppliers
            </div>
          )}

          {isEmpty && (
            <div className="px-4 py-10 text-center text-sm text-gray-400">
              No results for <span className="font-medium text-gray-600">&ldquo;{query}&rdquo;</span>
            </div>
          )}

          {groups.map(({ group, items }) => {
            const groupStart = allItems.indexOf(items[0])
            return (
              <div key={group}>
                <div className="px-4 pt-3 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                  {group}
                </div>
                {items.map((item, j) => {
                  const idx = groupStart + j
                  const active = idx === selectedIdx
                  return (
                    <button
                      key={item.id}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => navigate(item.href)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${active ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                    >
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${active ? 'bg-blue-100' : 'bg-gray-100'}`}>
                        {item.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate flex items-center gap-2">
                          {item.title}
                          {item.badge && (
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${item.badge.color}`}>
                              {item.badge.label}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-400 truncate mt-0.5">{item.subtitle}</div>
                      </div>
                      <ArrowRight size={13} className={`shrink-0 transition-opacity ${active ? 'text-blue-400 opacity-100' : 'opacity-0'}`} />
                    </button>
                  )
                })}
              </div>
            )
          })}

          {groups.length > 0 && (
            <div className="px-4 py-2 border-t border-gray-50 flex items-center gap-3 text-[10px] text-gray-300">
              <span><kbd className="font-mono bg-gray-100 px-1 rounded">↑↓</kbd> navigate</span>
              <span><kbd className="font-mono bg-gray-100 px-1 rounded">↵</kbd> open</span>
              <span><kbd className="font-mono bg-gray-100 px-1 rounded">esc</kbd> close</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
