'use client'
import { useEffect, useRef } from 'react'
import Link from 'next/link'
import type { SectionTab } from '@/lib/section-tabs'

// The row of tabs at the top of a section. Tabs replace the URL (no new
// history entry), so Back leaves the section instead of walking through every
// tab you touched. Scrolls sideways on a narrow phone, with the current tab
// brought into view.

export function SectionTabs({ tabs, active, label }: { tabs: SectionTab[]; active: string; label: string }) {
  const activeRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  if (tabs.length === 0) return null
  return (
    <nav aria-label={label} className="flex border-b border-line overflow-x-auto -mx-4 px-2 md:mx-0 md:px-0 [scrollbar-width:none]">
      {tabs.map(t => {
        const on = t.key === active
        const n = t.count ?? 0
        return (
          <Link
            key={t.key}
            ref={on ? activeRef : undefined}
            href={t.href}
            replace
            scroll={false}
            aria-current={on ? 'page' : undefined}
            className={`flex-none flex items-center gap-1.5 min-h-[44px] px-2.5 -mb-px border-b-2 whitespace-nowrap text-[13.5px] ${
              on ? 'border-gold text-ink font-semibold' : 'border-transparent text-ink-3 hover:text-ink-2'
            }`}
          >
            {t.label}
            {n > 0 && (
              <span className={`font-mono text-[10.5px] leading-none px-1.5 py-[3px] rounded-full ${
                t.alert ? 'bg-red text-white' : 'bg-bg-2 text-ink-3'
              }`}>
                {n}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
