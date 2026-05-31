'use client'

import { useState } from 'react'
import { Search, SlidersHorizontal } from 'lucide-react'
import { IcCheck } from '@/components/prep/icons'

interface PrepToolbarProps {
  search: string
  onSearch: (v: string) => void
  categories: string[]
  stations: string[]
  filterCategory: string // '' = All categories
  onFilterCategory: (v: string) => void
  filterStation: string // '' = All stations
  onFilterStation: (v: string) => void
  activeOnly: boolean
  onActiveOnly: (v: boolean) => void
  forceOpen?: boolean // when true (item count > 3), render expanded with the toggle hidden
}

export default function PrepToolbar({
  search,
  onSearch,
  categories,
  stations,
  filterCategory,
  onFilterCategory,
  filterStation,
  onFilterStation,
  activeOnly,
  onActiveOnly,
  forceOpen = false,
}: PrepToolbarProps) {
  const [open, setOpen] = useState(false)
  const visible = forceOpen || open

  if (!visible) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-[7px] font-mono text-[11px] text-ink-3 uppercase tracking-[0.04em] font-semibold mb-4 hover:text-ink"
      >
        <SlidersHorizontal className="w-[13px] h-[13px]" />
        Search &amp; filter
      </button>
    )
  }

  const anyActive =
    search !== '' || filterCategory !== '' || filterStation !== '' || activeOnly

  const clearAll = () => {
    onSearch('')
    onFilterCategory('')
    onFilterStation('')
    onActiveOnly(false)
  }

  return (
    <div className="flex items-center gap-[9px] mb-[18px]">
      <div className="flex-1 relative">
        <Search className="absolute left-[13px] top-1/2 -translate-y-1/2 text-ink-3 w-[15px] h-[15px]" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search prep items, recipes, stations…"
          className="w-full bg-paper border border-line rounded-[10px] py-2.5 pl-[38px] pr-3.5 text-[13px] text-ink outline-none focus:border-ink-3 placeholder:text-ink-3"
        />
      </div>

      <select
        value={filterCategory}
        onChange={(e) => onFilterCategory(e.target.value)}
        className={`border rounded-[10px] px-3 py-2.5 text-[13px] outline-none ${
          filterCategory !== ''
            ? 'bg-ink text-white border-ink'
            : 'bg-paper text-ink-2 border-line hover:border-ink-3'
        }`}
      >
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <select
        value={filterStation}
        onChange={(e) => onFilterStation(e.target.value)}
        className={`border rounded-[10px] px-3 py-2.5 text-[13px] outline-none ${
          filterStation !== ''
            ? 'bg-ink text-white border-ink'
            : 'bg-paper text-ink-2 border-line hover:border-ink-3'
        }`}
      >
        <option value="">All stations</option>
        {stations.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => onActiveOnly(!activeOnly)}
        className="inline-flex items-center gap-2 bg-paper border border-line rounded-[10px] px-3 py-[9px] text-[13px] text-ink-2 whitespace-nowrap"
      >
        <span
          className={
            activeOnly
              ? 'w-4 h-4 rounded bg-ink grid place-items-center text-white'
              : 'w-4 h-4 rounded border border-line-2 bg-paper grid place-items-center'
          }
        >
          {activeOnly && <IcCheck className="w-[11px] h-[11px]" />}
        </span>
        Active only
      </button>

      {anyActive && (
        <button
          type="button"
          onClick={clearAll}
          className="font-mono text-[11px] text-gold-2 font-semibold hover:underline whitespace-nowrap"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}
