'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

export interface SubNavTab {
  href: string
  label: string
  icon?: ReactNode
  exact?: boolean
}

interface SubNavProps {
  tabs: SubNavTab[]
  right?: ReactNode
}

/**
 * Per-page sub-nav strip (paper bg, gold underline on active).
 * Sits under the cost-chrome slot and above the page body.
 * Match: mock app/styles.css `.subnav`.
 */
export function SubNav({ tabs, right }: SubNavProps) {
  const pathname = usePathname()

  const isActive = (t: SubNavTab) =>
    t.exact || t.href === '/'
      ? pathname === t.href
      : pathname === t.href || pathname.startsWith(t.href + '/')

  return (
    <nav className="hidden md:flex items-stretch gap-0 px-8 bg-paper border-b border-line h-12">
      {tabs.map(tab => {
        const active = isActive(tab)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex items-center gap-[7px] px-[18px] text-[13.5px] font-medium tracking-[-0.005em] whitespace-nowrap border-b-2 transition-colors ${
              active
                ? 'border-gold text-ink'
                : 'border-transparent text-ink-3 hover:text-ink-2'
            }`}
          >
            {tab.icon}
            {tab.label}
          </Link>
        )
      })}
      {right !== undefined && (
        <div className="ml-auto flex items-center gap-2 py-[9px]">{right}</div>
      )}
      {right === undefined && (
        <div className="ml-auto flex items-center gap-2 py-[9px]">
          <kbd className="font-mono text-[10.5px] text-ink-3 bg-bg-2 border border-line rounded-md px-[7px] py-[3px]">⌘ K</kbd>
        </div>
      )}
    </nav>
  )
}
